/**
 * ok           — 取得できた
 * unconfigured — サービスアカウントトークンが未設定
 * error        — 設定はあるが取得に失敗した（op CLI が無い場合も含む）
 */
export type OnePasswordUsageStatus = "ok" | "unconfigured" | "error"

/** token はこのトークン単位の1時間枠、account は1Passwordアカウント全体の24時間枠 */
export type OnePasswordLimitType = "token" | "account"

export type OnePasswordLimitAction = "read" | "write" | "read_write"

export interface OnePasswordRateLimit {
    type: OnePasswordLimitType
    action: OnePasswordLimitAction
    limit: number
    used: number
    remaining: number
    /** 枠がリセットされる時刻（ISO 8601）。まだ1回も使っておらず起点が無ければ null */
    resetsAt: string | null
}

export interface OnePasswordUsageSnapshot {
    status: OnePasswordUsageStatus
    /** status が ok 以外のときに表示する理由 */
    message?: string
    limits: OnePasswordRateLimit[]
    /** 1Passwordへ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
