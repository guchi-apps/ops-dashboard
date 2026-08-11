/** 制限枠のリセットまでの残り時間を表示文にする。時刻が読めなければ null */
export function formatRemaining(resetsAt: string, now: number): string | null {
    const remainingMs = new Date(resetsAt).getTime() - now
    if (Number.isNaN(remainingMs)) return null
    if (remainingMs <= 0) return "まもなくリセット"

    const minutes = Math.floor(remainingMs / 60_000)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days >= 1) return `あと${days}日${hours % 24}時間でリセット`
    if (hours >= 1) return `あと${hours}時間${minutes % 60}分でリセット`
    return `あと${minutes}分でリセット`
}

/**
 * 制限枠のうち何割の時間が過ぎたかを返す。
 * 枠の開始と終了が両方分からないと出せないため、その場合は null を返す。
 */
export function getElapsedPercent(startsAtMs: number, endsAtMs: number, now: number): number | null {
    if (Number.isNaN(startsAtMs) || Number.isNaN(endsAtMs)) return null

    const totalMs = endsAtMs - startsAtMs
    if (totalMs <= 0) return null

    return Math.min(100, Math.max(0, Math.round(((now - startsAtMs) / totalMs) * 100)))
}
