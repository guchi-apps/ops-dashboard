import { cn } from "@/lib/utils"

function getUsageBarColor(percent: number): string {
    if (percent >= 90) return "bg-red-400"
    if (percent >= 75) return "bg-amber-400"
    return "bg-emerald-400"
}

interface UsageBarProps {
    /** 制限枠の表示名（例: "5時間", "無料枠"） */
    label: string
    /** ラベルの右に小さく添える補足（例: "Opus"） */
    note?: string
    /** 使用率（0-100） */
    usedPercent: number
    /** 制限枠のうち経過した割合（0-100）。出せないなら null */
    elapsedPercent?: number | null
    /** 右上に大きく出す値。省略時は「残り ○%」 */
    valueText?: string
    /** 左下に出す使用量。省略時は「使用 ○%」 */
    usedText?: string
    /** 右下に出すリセットまでの残り時間 */
    remainingText?: string | null
}

/**
 * 使用量のバー。塗りが「経過した時間の位置」を示す縦線を越えていれば、使うペースが速いと判断できる。
 * AI使用状況とGitHub使用状況で同じ見た目を保つため共通化している。
 */
export function UsageBar({
    label,
    note,
    usedPercent,
    elapsedPercent = null,
    valueText,
    usedText,
    remainingText,
}: UsageBarProps) {
    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium">
                    {label}
                    {note && <span className="ml-1 text-[10px] sm:text-xs opacity-70">{note}</span>}
                </span>
                <span className="font-mono text-sm sm:text-base font-bold">
                    {valueText ?? `残り ${Math.round(100 - usedPercent)}%`}
                </span>
            </div>

            <div className="relative">
                <div
                    className="h-2 w-full overflow-hidden rounded-full bg-primary-foreground/20 dark:bg-muted"
                    role="progressbar"
                    aria-label={`${label}の使用率`}
                    aria-valuenow={Math.round(usedPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuetext={
                        elapsedPercent === null
                            ? undefined
                            : `使用 ${usedPercent}%、経過 ${elapsedPercent}%`
                    }
                >
                    <div
                        className={cn("h-full rounded-full transition-all", getUsageBarColor(usedPercent))}
                        style={{ width: `${usedPercent}%` }}
                    />
                </div>

                {/* 時間の進み方との比較用。バーの塗りがこの線を越えていれば使うペースが速い */}
                {elapsedPercent !== null && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 -my-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
                        style={{ left: `${elapsedPercent}%` }}
                    />
                )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                <span>
                    {usedText ?? `使用 ${usedPercent}%`}
                    {elapsedPercent !== null && <span className="ml-1.5">経過 {elapsedPercent}%</span>}
                </span>
                {remainingText && <span>{remainingText}</span>}
            </div>
        </div>
    )
}
