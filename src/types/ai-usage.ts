export type AiProviderId = "claude" | "chatgpt"

/**
 * ok           — 使用状況を取得できた
 * unconfigured — 認証情報が未設定
 * error        — 設定はあるが取得に失敗した
 */
export type AiUsageStatus = "ok" | "unconfigured" | "error"

export interface AiUsageWindow {
    /** 制限枠の表示名（例: "5時間", "週間"） */
    label: string
    /** 使用率（0-100） */
    usedPercent: number
    /** 制限枠がリセットされる時刻（ISO 8601）。不明なら null */
    resetsAt: string | null
    /** 制限枠の長さ（秒）。不明なら null。resetsAt と組み合わせて経過時間を出すのに使う */
    windowSeconds: number | null
    /** 補足表示（例: "Opus"） */
    note?: string
}

/** プラン枠を超えた分の課金状況（Claude の追加利用クレジットなど） */
export interface AiProviderBilling {
    /** 項目名（例: "追加利用クレジット"） */
    label: string
    /** 表示用の金額（例: "$64.61"） */
    amount: string
    /** 上限が設定されている場合の表示用の金額 */
    limit?: string
}

export interface AiProviderUsage {
    id: AiProviderId
    name: string
    /** 課金プランの表示名。取得も設定もできない場合は null */
    plan: string | null
    status: AiUsageStatus
    /** status が ok 以外のときに表示する理由 */
    message?: string
    windows: AiUsageWindow[]
    billing?: AiProviderBilling
}

export interface AiUsageSnapshot {
    providers: AiProviderUsage[]
    /** 各提供元へ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
