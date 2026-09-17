import { cn } from "@/lib/utils"
import type { UsageBarMarker } from "@/lib/usage-format"

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
    /** バーに重ねる細い目盛り。1日を超える枠で「1日の区切り」を出すのに使う */
    markers?: UsageBarMarker[]
}

/** 目盛りの内訳。1px の線はホバーで狙えないため、説明はバー全体の title として出す */
function markersTitle(markers: UsageBarMarker[]): string | undefined {
    return markers.length > 0 ? markers.map((marker) => marker.label).join("\n") : undefined
}

/** 目盛りは見た目だけの線なので、読み上げには使用率と同じ場所から内訳を伝える */
function ariaValueText(
    usedPercent: number,
    elapsedPercent: number | null,
    markers: UsageBarMarker[]
): string | undefined {
    const parts = [
        elapsedPercent === null ? null : `使用 ${usedPercent}%、経過 ${elapsedPercent}%`,
        markers.length > 0 ? `日ごと: ${markers.map((marker) => marker.label).join("、")}` : null,
    ].filter((part): part is string => part !== null)

    return parts.length > 0 ? parts.join("。") : undefined
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
    markers = [],
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

            <div className="relative" title={markersTitle(markers)}>
                <div
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={`${label}の使用率`}
                    aria-valuenow={Math.round(usedPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuetext={ariaValueText(usedPercent, elapsedPercent, markers)}
                >
                    <div
                        className={cn("h-full rounded-full transition-all", getUsageBarColor(usedPercent))}
                        style={{ width: `${usedPercent}%` }}
                    />
                </div>

                {/*
                 * 1日の区切り。位置はその日の終わりまでの累計使用率で、線と線の間隔がその日に使った量になる。
                 * 経過時間の線（太い実線）と見分けが付くよう、細い点線にして上に重ねない。
                 */}
                {markers.map((marker) => (
                    <span
                        key={`${marker.percent}-${marker.label}`}
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 -my-0.5 w-px -translate-x-1/2 text-foreground/50"
                        style={{
                            left: `${marker.percent}%`,
                            backgroundImage:
                                "repeating-linear-gradient(to bottom, currentColor 0 2px, transparent 2px 4px)",
                        }}
                    />
                ))}

                {/* 時間の進み方との比較用。バーの塗りがこの線を越えていれば使うペースが速い */}
                {elapsedPercent !== null && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 -my-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/80"
                        style={{ left: `${elapsedPercent}%` }}
                    />
                )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-2 text-[10px] sm:text-xs text-muted-foreground">
                <span>
                    {usedText ?? `使用 ${usedPercent}%`}
                    {elapsedPercent !== null && <span className="ml-1.5">経過 {elapsedPercent}%</span>}
                </span>
                {remainingText && <span>{remainingText}</span>}
            </div>
        </div>
    )
}
