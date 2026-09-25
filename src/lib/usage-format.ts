import type { AiUsageDayMark } from "@/types/ai-usage"

/** 使用量バーに重ねる目盛り。位置は時間ではなく使用率（0-100）で指定する */
export interface UsageBarMarker {
    percent: number
    /** ホバーで出す説明（例: "3日目 +5%（累計 26%）"） */
    label: string
}

/**
 * 1日ごとの区切りを使用量バーの目盛りにする。
 * 位置はその日の終わりまでの累計使用率で、直前の区切りとの差がその日に使った量になる。
 * 記録が無い日は配列から抜けるため、飛んだぶんは「2〜4日目」のようにまとめて表す。
 */
export function toDayMarkers(dayMarks: AiUsageDayMark[] | undefined): UsageBarMarker[] {
    if (!dayMarks || dayMarks.length === 0) return []

    let previousDay = 0
    let previousPercent = 0

    return dayMarks.map((mark) => {
        const span =
            previousDay + 1 === mark.day ? `${mark.day}日目` : `${previousDay + 1}〜${mark.day}日目`
        const used = Math.round(Math.max(0, mark.usedPercent - previousPercent))

        previousDay = mark.day
        previousPercent = mark.usedPercent

        return {
            percent: mark.usedPercent,
            label: `${span} +${used}%（累計 ${Math.round(mark.usedPercent)}%）`,
        }
    })
}

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

/** 購入クレジットの失効までの残り時間を表示文にする。resetsAtの「リセット」と違い、来ても補充されないため文言を分ける */
export function formatExpiry(expiresAt: string, now: number): string | null {
    const remainingMs = new Date(expiresAt).getTime() - now
    if (Number.isNaN(remainingMs)) return null
    if (remainingMs <= 0) return "期限切れ"

    const minutes = Math.floor(remainingMs / 60_000)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days >= 1) return `期限まであと${days}日${hours % 24}時間`
    if (hours >= 1) return `期限まであと${hours}時間${minutes % 60}分`
    return `期限まであと${minutes}分`
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

/** Actions の無料枠の使用率（%）。上限が無ければ 0 */
export function getActionsUsedPercent(actions: {
    allowanceMinutes: number
    allowanceLimitMinutes: number
}): number {
    if (actions.allowanceLimitMinutes <= 0) return 0
    return Math.round((actions.allowanceMinutes / actions.allowanceLimitMinutes) * 1000) / 10
}

/** APIレート制限の使用率（%） */
export function getRateLimitUsedPercent(rateLimit: { used: number; limit: number }): number {
    if (rateLimit.limit <= 0) return 0
    return Math.round((rateLimit.used / rateLimit.limit) * 1000) / 10
}

/** トークン数を「142万」のように短く整える */
export function formatTokens(tokens: number): string {
    return new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(tokens)
}

/** USDの金額。1セント未満は桁を増やして、0円に見えないようにする */
export function formatUsd(value: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value < 0.01 ? 4 : 2,
    }).format(value)
}
