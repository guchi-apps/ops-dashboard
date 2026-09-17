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

/**
 * サブスクの制限枠とは別会計のクレジット枠。
 * Claude は月ごとの追加利用（使った分だけ課金される）、ChatGPT は前払いで買ったクレジットの残高で、
 * 単位も期限の有無も違う。画面では同じ1行として出すため、整形済みの文字列で受け取る。
 */
export interface AiProviderCredit {
    /** 右上に大きく出す値（例: "残り $68.18", "残り 1,200 クレジット", "無制限", "未設定"） */
    valueText: string
    /** 使用率（0-100）。上限が無く割合を出せない場合は null（バーを出さない） */
    usedPercent: number | null
    /** 左下に出す内訳（例: "購入 $131.82 / 上限 $200.00"）。無ければ null */
    detailText: string | null
    /** 枠がリセットされる時刻（ISO 8601）。期限が無ければ null */
    resetsAt: string | null
    /** 使用ペース比較の開始時刻（ISO 8601）。不明なら省略する */
    startsAt?: string | null
}

/**
 * 制限枠1つぶんの実績。提供元は過去の枠を返さないため、
 * ダッシュボード側で観測して積み上げた値になる（src/lib/ai-usage/history.ts）。
 */
export interface AiUsageWindowRecord {
    /** 枠のリセット時刻（ISO 8601）。枠の識別子も兼ねる */
    resetsAt: string
    /** その枠で観測できた最大の使用率（0-100） */
    usedPercent: number
    /** まだ終わっていない枠か */
    inProgress: boolean
    /** 枠の終了間際に観測できておらず、実際より低い値で確定している可能性があるか */
    undersampled: boolean
}

/** 制限枠の種類（5時間・週間 …）ごとの使い切り実績 */
export interface AiUsageWindowHistory {
    /** 枠の表示名（{@link AiUsageWindow.label} と同じ） */
    label: string
    note?: string
    windowSeconds: number
    /** リセット時刻の古い順。進行中の枠があれば末尾に入る */
    records: AiUsageWindowRecord[]
    /** 終わった枠の平均使い切り率（0-100）。終わった枠がまだ無ければ null */
    averagePercent: number | null
    /** 使い切った枠の数 */
    fullCount: number
    /** 平均・使い切り回数の母数（終わった枠の数） */
    completedCount: number
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
    credit?: AiProviderCredit
    /** 終わった枠の使い切り実績。記録がまだ無ければ省略される */
    windowHistory?: AiUsageWindowHistory[]
}

export interface AiUsageSnapshot {
    providers: AiProviderUsage[]
    /** 各提供元へ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
