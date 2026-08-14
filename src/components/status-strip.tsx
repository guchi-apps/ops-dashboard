"use client"

import { BORDER_TONES, TEXT_TONES } from "@/components/status-badge"
import type { SummaryChip } from "@/lib/dashboard-summary"
import { cn } from "@/lib/utils"

/**
 * 画面上部に常時出す集約チップ。
 *
 * タブを切り替えても隠れない位置に置き、「いま異常があるか」だけはどのタブからでも見えるようにする。
 * 狭い画面では横スクロールさせ、折り返して縦に伸びるのを避ける。
 */
export function StatusStrip({ chips }: { chips: SummaryChip[] }) {
    if (chips.length === 0) return null

    return (
        <div className="-mx-3 overflow-x-auto px-3 pb-1 sm:mx-0 sm:px-0" role="status" aria-label="全体の状況">
            <div className="flex min-w-max gap-2 sm:min-w-0">
                {chips.map((chip) => (
                    <div
                        key={chip.key}
                        className={cn(
                            "flex min-w-[9.5rem] flex-1 flex-col gap-0.5 rounded-xl border border-l-[3px] bg-card px-3 py-1.5",
                            BORDER_TONES[chip.tone]
                        )}
                    >
                        <span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                            {chip.label}
                        </span>
                        <span
                            className={cn(
                                "truncate font-mono text-sm font-bold sm:text-[15px]",
                                chip.tone === "neutral" ? "text-foreground" : TEXT_TONES[chip.tone]
                            )}
                        >
                            {chip.value}
                        </span>
                        {chip.note && (
                            <span className="truncate text-[10px] text-muted-foreground" title={chip.note}>
                                {chip.note}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
