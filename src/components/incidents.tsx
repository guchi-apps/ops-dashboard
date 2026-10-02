"use client"

import { Siren, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { applyIncidentBadge } from "@/lib/incidents/badge-client"
import type { HostEventKind, IncidentSnapshot } from "@/lib/incidents/types"
import { cn } from "@/lib/utils"

/**
 * 未解消エラーの件数と一覧（#495）。件数はサーバーが定期処理で計算した値（`GET /api/incidents`）で、
 * ヘッダーのボタン・この一覧・PWAアイコンのバッジはすべて同じスナップショットから作る。
 * 画面を開いただけでは件数は消えない（消えるのは原因が解消したときだけ）。
 */

const POLL_MS = 60_000

/** 画面内の件数・一覧と、PWAバッジをサーバーの最新状態に合わせ続ける */
export function useIncidents(): IncidentSnapshot | null {
    const [snapshot, setSnapshot] = useState<IncidentSnapshot | null>(null)
    const latestSeq = useRef(-1)

    const sync = useCallback(async () => {
        const res = await fetch("/api/incidents", { cache: "no-store" }).catch(() => null)
        if (!res?.ok) return
        const next = (await res.json()) as IncidentSnapshot
        // 遅れて返った古い応答で、件数を巻き戻さない
        if (next.seq < latestSeq.current) return
        latestSeq.current = next.seq
        setSnapshot(next)
        void applyIncidentBadge(next)
    }, [])

    useEffect(() => {
        void sync()
        const timer = window.setInterval(() => void sync(), POLL_MS)
        // 閉じていた間の変化は、開き直した・前面に戻ったときにすぐ同期する
        const onVisible = () => {
            if (document.visibilityState === "visible") void sync()
        }
        document.addEventListener("visibilitychange", onVisible)
        window.addEventListener("online", onVisible)
        return () => {
            window.clearInterval(timer)
            document.removeEventListener("visibilitychange", onVisible)
            window.removeEventListener("online", onVisible)
        }
    }, [sync])

    return snapshot
}

export function IncidentButton({
    snapshot,
    open,
    onToggle,
    controlsId,
}: {
    snapshot: IncidentSnapshot | null
    open: boolean
    onToggle: () => void
    controlsId: string
}) {
    if (!snapshot) return null
    const count = snapshot.count
    const attention = count > 0 || snapshot.unavailable.length > 0

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={controlsId}
            aria-label={count > 0 ? `未解消のエラー ${count}件` : "未解消のエラーはありません"}
            className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-md border border-border",
                "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                attention ? "text-red-300" : "text-muted-foreground"
            )}
        >
            <Siren className="size-4" aria-hidden />
            {count > 0 && (
                <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-4 text-white">
                    {count > 99 ? "99+" : count}
                </span>
            )}
        </button>
    )
}

const EVENT_LABELS: Record<HostEventKind, string> = {
    down: "受信が途絶えた",
    recovered: "受信が再開",
    restart: "再起動",
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })
}

export function IncidentPanel({
    snapshot,
    id,
    onClose,
}: {
    snapshot: IncidentSnapshot
    id: string
    onClose: () => void
}) {
    return (
        <section id={id} aria-label="未解消のエラー" className="mb-3 rounded-xl border border-border bg-card p-3 text-xs">
            <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[13px] font-bold">
                    未解消のエラー
                    <span className={cn("ml-1.5", snapshot.count > 0 ? "text-red-300" : "text-muted-foreground")}>
                        {snapshot.count}件
                    </span>
                </h2>
                <Button variant="ghost" size="icon" type="button" onClick={onClose} className="ml-auto size-7" aria-label="閉じる">
                    <X className="size-4" aria-hidden />
                </Button>
            </div>

            {snapshot.incidents.length === 0 ? (
                <p className="text-muted-foreground">未解消のエラーはありません。</p>
            ) : (
                <ul className="space-y-1.5">
                    {snapshot.incidents.map((incident) => (
                        <li key={incident.key} className="rounded-md bg-muted px-2.5 py-1.5">
                            <p className="font-bold">{incident.title}</p>
                            <p className="text-muted-foreground">
                                {formatTime(incident.since)} から{incident.detail ? ` ・ ${incident.detail}` : ""}
                            </p>
                        </li>
                    ))}
                </ul>
            )}

            {snapshot.unavailable.length > 0 && (
                <div className="mt-2">
                    <p className="font-bold text-amber-300">取得できていない対象（件数には含まれません）</p>
                    <ul className="list-disc pl-4 text-muted-foreground">
                        {snapshot.unavailable.map((entry) => (
                            <li key={entry}>{entry}</li>
                        ))}
                    </ul>
                </div>
            )}

            {snapshot.events.length > 0 && (
                <div className="mt-2">
                    <p className="font-bold">ホストの通知履歴</p>
                    <ul className="text-muted-foreground">
                        {snapshot.events.map((event) => (
                            <li key={event.id}>
                                {formatTime(event.at)} {event.label}: {EVENT_LABELS[event.kind]}
                                {event.kind === "recovered" && event.rebooted ? "（再起動後）" : ""}
                                <span className="ml-1">（最終受信 {formatTime(event.lastReceivedAt)}）</span>
                            </li>
                        ))}
                    </ul>
                    <p className="mt-1 text-[11px] text-muted-foreground">履歴は件数には含まれません。</p>
                </div>
            )}
        </section>
    )
}
