import { cn } from "@/lib/utils"
import type { AiUsageWindowHistory, AiUsageWindowRecord } from "@/types/ai-usage"

/**
 * 終わった制限枠を1本ずつ並べて「どれだけ使えたか」を見せる。
 *
 * 既存の {@link import("@/components/usage-bar").UsageBar} と違い、使用率で赤・橙へ色を変えない。
 * こちらは「払っている枠を使い切れたか」を見る場所で、たくさん使ったことは悪い状態ではないため、
 * 同じ色使いにすると意味が逆に読めてしまう（濃い＝使った量、薄い＝使い残し）。
 */

/** 斜線の向きと間隔。観測が足りない枠を、色を変えずに区別するために使う */
const UNDERSAMPLED_PATTERN =
    "repeating-linear-gradient(135deg, rgba(255,255,255,0.5) 0 2px, rgba(255,255,255,0) 2px 5px)"

/** 一番古い棒の下に出す「いつの枠か」。週をまたぐ枠は週で数えたほうが読みやすい */
function formatAgo(resetsAt: string, now: number): string | null {
    const elapsedMs = now - new Date(resetsAt).getTime()
    if (Number.isNaN(elapsedMs) || elapsedMs < 0) return null

    const hours = Math.floor(elapsedMs / 3_600_000)
    if (hours < 24) return hours <= 0 ? "さっき" : `${hours}時間前`

    const days = Math.floor(hours / 24)
    return days >= 14 ? `${Math.round(days / 7)}週前` : `${days}日前`
}

function describeRecord(record: AiUsageWindowRecord): string {
    const resetsAt = new Date(record.resetsAt).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })

    if (record.inProgress) return `${resetsAt} にリセット（集計中）・使用 ${record.usedPercent}%`
    return `${resetsAt} リセット・使用 ${record.usedPercent}%${
        record.undersampled ? "（観測が足りず低い可能性）" : ""
    }`
}

function UsageColumn({ record }: { record: AiUsageWindowRecord }) {
    return (
        <div
            title={describeRecord(record)}
            className={cn(
                "flex h-full flex-1 flex-col justify-end rounded-[3px]",
                record.inProgress
                    ? "border border-dashed border-primary"
                    : "overflow-hidden bg-muted"
            )}
        >
            <div
                className={cn("rounded-t-[3px]", record.inProgress ? "bg-primary/45" : "bg-primary")}
                style={{
                    height: `${record.usedPercent}%`,
                    backgroundImage: record.undersampled ? UNDERSAMPLED_PATTERN : undefined,
                }}
            />
        </div>
    )
}

function HistoryRow({ history, now }: { history: AiUsageWindowHistory; now: number }) {
    const { records, averagePercent, completedCount, fullCount } = history
    const oldest = records[0] ? formatAgo(records[0].resetsAt, now) : null
    const hasCurrent = records.at(-1)?.inProgress === true

    return (
        <div className="space-y-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-[11px] sm:text-xs font-medium">
                    {history.label}枠
                    {history.note && (
                        <span className="ml-1 text-[10px] sm:text-xs opacity-70">{history.note}</span>
                    )}
                </span>
                <span className="font-mono text-[10px] sm:text-[11px] text-muted-foreground">
                    {averagePercent === null ? (
                        "記録待ち"
                    ) : (
                        <>
                            平均{" "}
                            <span className="text-[11px] sm:text-xs font-bold text-foreground">
                                {averagePercent}%
                            </span>{" "}
                            ・ 使い切り{" "}
                            <span className="text-[11px] sm:text-xs font-bold text-foreground">
                                {fullCount}
                            </span>
                            /{completedCount}
                        </>
                    )}
                </span>
            </div>

            <div
                role="img"
                aria-label={
                    averagePercent === null
                        ? `${history.label}枠の使い切り率。終わった枠はまだありません`
                        : `${history.label}枠の使い切り率。終わった${completedCount}枠の平均 ${averagePercent}%、うち使い切りは${fullCount}枠`
                }
                className="relative flex h-9 items-end gap-[3px] sm:h-11"
            >
                {/* 平均の位置。棒がこの線を越えていれば、その枠はいつもより使えている */}
                {averagePercent !== null && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/35"
                        style={{ bottom: `${averagePercent}%` }}
                    />
                )}
                {records.map((record) => (
                    <UsageColumn key={record.resetsAt} record={record} />
                ))}
            </div>

            <div className="flex justify-between text-[9px] sm:text-[10px] text-muted-foreground">
                <span>{oldest ?? ""}</span>
                <span>{hasCurrent ? "いまの枠" : "最新"}</span>
            </div>
        </div>
    )
}

function Legend({ showUndersampled }: { showUndersampled: boolean }) {
    return (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] leading-relaxed text-muted-foreground sm:text-[10px]">
            <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-[2px] bg-primary" aria-hidden />
                使った量
            </span>
            <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-[2px] border border-border bg-muted" aria-hidden />
                使い残し
            </span>
            <span className="inline-flex items-center gap-1">
                <span
                    className="size-2 rounded-[2px] border border-dashed border-primary bg-primary/45"
                    aria-hidden
                />
                集計中
            </span>
            {showUndersampled && <span>斜線は観測が足りない枠（実際より低い可能性）</span>}
        </div>
    )
}

export function AiUsageHistory({
    history,
    now,
}: {
    history: AiUsageWindowHistory[]
    now: number
}) {
    if (history.length === 0) return null

    const showUndersampled = history.some((entry) =>
        entry.records.some((record) => record.undersampled)
    )

    return (
        <div className="space-y-2.5 border-t border-border pt-2.5">
            <div className="flex items-baseline gap-2">
                <span className="text-[11px] sm:text-xs font-bold">枠の使い切り</span>
                <span className="ml-auto font-mono text-[9px] sm:text-[10px] text-muted-foreground">
                    終わった枠ごと
                </span>
            </div>

            {history.map((entry) => (
                <HistoryRow key={`${entry.windowSeconds}-${entry.note ?? ""}`} history={entry} now={now} />
            ))}

            <Legend showUndersampled={showUndersampled} />
        </div>
    )
}
