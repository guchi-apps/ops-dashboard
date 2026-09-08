"use client"

import { useId, useState } from "react"
import { Plus, X } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { MonitorCard, MonitorCardGrid } from "@/components/monitor-card"
import { SectionHeading } from "@/components/section-heading"
import { Button, buttonVariants } from "@/components/ui/button"
import { UptimeKumaDashboardCard } from "@/components/uptime-kuma-card"
import { getUptimeRobotStatusInfo } from "@/lib/uptimerobot"

/**
 * 監視タブの中身。
 *
 * 概要タブのタイルは状態だけを詰めて並べるのに対して、こちらはheartbeatや応答時間まで出す。
 * モニター追加のURLはサーバー側の環境変数から作るため、ページから受け取る。
 */
export function MonitorSections({
    addMonitorUrl,
    canAddMonitor,
}: {
    addMonitorUrl: string | null
    /** Kumaの管理者認証情報が揃っていて、この画面から直接登録できるか */
    canAddMonitor: boolean
}) {
    const { uptimeKuma, uptimeRobot } = useDashboardData()

    return (
        <div className="space-y-5">
            {/*
              * 見出しと追加の入り口は、取得できたモニターの件数から切り離している。
              * Kumaの取得に失敗したときも一覧は0件になるため（src/lib/uptime-kuma.ts）、
              * 件数で囲うと「登録したい・Kumaを開きたい」状況でちょうど入り口が消える。
              */}
            {(canAddMonitor || addMonitorUrl !== null) && (
                <section className="space-y-3">
                    {canAddMonitor ? (
                        <AddMonitorPanel />
                    ) : (
                        <SectionHeading
                            title="Uptime Kuma"
                            trailing={
                                addMonitorUrl && (
                                    <a
                                        href={addMonitorUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={buttonVariants({ variant: "outline", size: "sm" })}
                                    >
                                        <Plus aria-hidden />
                                        モニター追加
                                    </a>
                                )
                            }
                        />
                    )}
                    {uptimeKuma.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Uptime Kuma のモニターが取得できません。ステータスページの設定を確認してください。
                        </p>
                    ) : (
                        <MonitorCardGrid count={uptimeKuma.length}>
                            {uptimeKuma.map((monitor) => (
                                <UptimeKumaDashboardCard key={monitor.id} monitor={monitor} />
                            ))}
                        </MonitorCardGrid>
                    )}
                </section>
            )}

            <section className="space-y-3">
                <SectionHeading title="UptimeRobot" />
                {uptimeRobot.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        UptimeRobot のモニターが取得できません。APIキーを確認してください。
                    </p>
                ) : (
                    <MonitorCardGrid count={uptimeRobot.length}>
                        {uptimeRobot.map((monitor) => {
                            const status = getUptimeRobotStatusInfo(monitor.status)
                            const ratio = parseFloat(
                                (monitor.custom_uptime_ratio || monitor.uptime_ratio || "0").split("-")[0]
                            )

                            return (
                                <MonitorCard
                                    key={monitor.id}
                                    label={monitor.friendly_name}
                                    statusText={status.text}
                                    statusColor={status.color}
                                    uptimeLabel={`${ratio}% uptime (30d)`}
                                    href={monitor.url}
                                />
                            )
                        })}
                    </MonitorCardGrid>
                )}
            </section>
        </div>
    )
}

const INPUT_CLASS =
    "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"

type SubmitState =
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "done"; message: string }
    | { kind: "error"; message: string }

/**
 * 見出しと、モニターを追加するフォーム。
 *
 * Kumaの画面を開かずにここで登録できるようにしている。登録に成功したらKumaの一覧だけを
 * 取り直して、追加したモニターがそのまま下に並ぶようにする。
 */
function AddMonitorPanel() {
    const { refreshUptimeKuma } = useDashboardData()
    const nameId = useId()
    const urlId = useId()

    const [open, setOpen] = useState(false)
    const [name, setName] = useState("")
    const [url, setUrl] = useState("")
    const [state, setState] = useState<SubmitState>({ kind: "idle" })

    const sending = state.kind === "sending"

    const submit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (sending) return

        setState({ kind: "sending" })

        try {
            const res = await fetch("/api/uptime-kuma/monitors", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, url }),
            })
            const payload = (await res.json()) as { error?: string; created?: boolean }

            if (!res.ok) {
                setState({ kind: "error", message: payload.error ?? `登録に失敗しました（${res.status}）` })
                return
            }

            setState({
                kind: "done",
                message: payload.created
                    ? `「${name}」を追加しました。`
                    : `同じURLのモニターが既にあったため、追加していません。`,
            })
            setName("")
            setUrl("")
            await refreshUptimeKuma()
        } catch {
            setState({ kind: "error", message: "登録に失敗しました。通信を確認してください。" })
        }
    }

    return (
        <div className="space-y-3">
            <SectionHeading
                title="Uptime Kuma"
                trailing={
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setOpen((current) => !current)
                            setState({ kind: "idle" })
                        }}
                        aria-expanded={open}
                    >
                        {open ? <X aria-hidden /> : <Plus aria-hidden />}
                        {open ? "閉じる" : "モニター追加"}
                    </Button>
                }
            />

            {open && (
                <form
                    onSubmit={submit}
                    className="rounded-lg border bg-card p-4 space-y-3 sm:flex sm:items-end sm:gap-3 sm:space-y-0"
                >
                    <div className="space-y-1.5 sm:flex-1 sm:min-w-0">
                        <label htmlFor={nameId} className="block text-xs text-muted-foreground">
                            名前
                        </label>
                        <input
                            id={nameId}
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="My App"
                            required
                            disabled={sending}
                        />
                    </div>
                    <div className="space-y-1.5 sm:flex-[2] sm:min-w-0">
                        <label htmlFor={urlId} className="block text-xs text-muted-foreground">
                            URL
                        </label>
                        <input
                            id={urlId}
                            className={INPUT_CLASS}
                            type="url"
                            value={url}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder="https://example.com"
                            required
                            disabled={sending}
                        />
                    </div>
                    <Button type="submit" size="sm" disabled={sending} className="w-full sm:w-auto">
                        {sending ? "登録中…" : "登録"}
                    </Button>
                </form>
            )}

            {state.kind === "done" && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.message}</p>
            )}
            {state.kind === "error" && (
                <p className="text-sm text-destructive">{state.message}</p>
            )}
        </div>
    )
}
