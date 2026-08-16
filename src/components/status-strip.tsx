"use client"

import { BORDER_TONES, TEXT_TONES } from "@/components/status-badge"
import type { SummaryChip } from "@/lib/dashboard-summary"
import { cn } from "@/lib/utils"

/**
 * 画面上部に常時出す集約チップ。
 *
 * タブを切り替えても隠れない位置に置き、「いま異常があるか」だけはどのタブからでも見えるようにする。
 *
 * チップの幅は中身に合わせ、値も注記も省略しない（#96）。等幅に揃えると、tmux のように
 * 長い値が途中で切れて読めなくなる。狭い画面では横スクロール、広い画面では伸ばしつつ折り返す。
 */
export function StatusStrip({ chips }: { chips: SummaryChip[] }) {
    if (chips.length === 0) return null

    return (
        <div
            className="-mx-3 overflow-x-auto px-3 pb-1 sm:mx-0 sm:overflow-x-visible sm:px-0"
            role="status"
            aria-label="全体の状況"
        >
            <div className="flex min-w-max gap-2 sm:min-w-0 sm:flex-wrap">
                {chips.map((chip) => (
                    <div
                        key={chip.key}
                        className={cn(
                            "flex w-max shrink-0 flex-col gap-0.5 rounded-xl border border-l-[3px] bg-card px-3 py-1.5",
                            "sm:w-auto sm:min-w-[9.5rem] sm:flex-auto",
                            BORDER_TONES[chip.tone]
                        )}
                    >
                        <span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                            {chip.label}
                        </span>
                        <span
                            className={cn(
                                "whitespace-nowrap font-mono text-sm font-bold sm:text-[15px]",
                                chip.tone === "neutral" ? "text-foreground" : TEXT_TONES[chip.tone]
                            )}
                        >
                            {chip.value}
                        </span>
                        {chip.note && (
                            <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                                {chip.note}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
