"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { StatusDot } from "@/components/status-badge"
import { formatAideDateTime } from "@/lib/aide-status-format"
import { cn } from "@/lib/utils"
import type { AideJob } from "@/types/aide-status"

/** 表示する実行記録の上限（#387） */
const MAX_RUNS = 30

/**
 * 定期ジョブ1本の実行記録を出すモーダル（#387）。
 *
 * 祖先にタブ切り替えの transform アニメーションがあり、その中の `fixed` は画面ではなく
 * その祖先に対して配置されてしまうため、body 直下へ portal で出す。
 * 重なり順は固定ヘッダー（z-30）・メニュー（z-50）より上にする。
 */
export function JobHistoryModal({ job, onClose }: { job: AideJob; onClose: () => void }) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const runs = (job.recentRuns ?? []).slice(0, MAX_RUNS)
    const failures = runs.filter((run) => !run.ok).length

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)

        return () => {
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            previouslyFocused?.focus()
        }
    }, [onClose])

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`${job.name} の実行記録`}
                onClick={(event) => event.stopPropagation()}
                className="flex max-h-[82dvh] w-full max-w-[440px] flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:max-h-[min(80dvh,720px)] sm:rounded-2xl"
            >
                <div className="flex shrink-0 items-start gap-2.5 border-b border-border px-4 pb-3 pt-3.5">
                    <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-bold [overflow-wrap:anywhere]">{job.name}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {job.interval}の実行記録
                        </div>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="閉じる"
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                        ✕
                    </button>
                </div>

                {runs.length === 0 ? (
                    <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                        実行記録がありません。AIDE側が履歴を返すようになると、ここに直近30件が並びます。
                    </p>
                ) : (
                    <>
                        <div className="shrink-0 border-b border-border px-4 py-2.5 text-[11px] text-muted-foreground">
                            直近 <b className="font-mono text-foreground">{runs.length}</b> 件 ·{" "}
                            <b className="font-mono text-foreground">{runs.length - failures}</b> 成功 /{" "}
                            <b className="font-mono text-foreground">{failures}</b> 失敗
                        </div>
                        <ul className="min-h-0 flex-1 overflow-y-auto">
                            {runs.map((run, index) => (
                                <li
                                    key={`${run.at}-${index}`}
                                    className="flex items-start gap-2.5 border-b border-border/60 px-4 py-2.5 last:border-b-0"
                                >
                                    <StatusDot tone={run.ok ? "ok" : "danger"} className="mt-1.5 size-[7px]" />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline gap-2 text-xs">
                                            <span className="font-mono tabular-nums">
                                                {formatAideDateTime(run.at)}
                                            </span>
                                            <span
                                                className={cn(
                                                    "font-semibold",
                                                    run.ok ? "text-status-ok" : "text-red-400"
                                                )}
                                            >
                                                {run.ok ? "成功" : "失敗"}
                                            </span>
                                            <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                                                {run.seconds.toFixed(1)}s · {run.host}
                                            </span>
                                        </div>
                                        {run.message && (
                                            <div
                                                className={cn(
                                                    "mt-0.5 text-[11px] [overflow-wrap:anywhere]",
                                                    run.ok ? "text-muted-foreground" : "text-red-300"
                                                )}
                                            >
                                                {run.message}
                                            </div>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <div className="shrink-0 border-t border-border px-4 py-2 text-[10.5px] leading-normal text-muted-foreground">
                    新しい順に並んでいます。表示するのは直近{MAX_RUNS}件までです。
                </div>
            </div>
        </div>,
        document.body
    )
}
