export type AiProviderId = "claude" | "chatgpt"

/**
 * ok           — 使用状況を取得できた
 * unconfigured — 認証情報が未設定
 * error        — 設定はあるが取得に失敗した
 */
export type AiUsageStatus = "ok" | "unconfigured" | "error"

/**
 * 1日を超える制限枠（週間など）で、枠の中の「1日の終わり」に立てる区切り。
 *
 * 位置に使うのは時刻ではなく**その時点までの累計使用率**で、隣り合う区切りの間隔が
 * その日に使った量になる。値は取得のたびに記録したものを読んでいるため、
 * 一度も画面を開かなかった日の区切りは存在しない（配列から抜ける）。
 */
export interface AiUsageDayMark {
    /** 枠の開始から数えて何日目の終わりか（1始まり） */
    day: number
    /** その時点までの累計使用率（0-100） */
    usedPercent: number
    /** 区切りの時刻（ISO 8601） */
    at: string
    /** この値を観測した時刻（ISO 8601）。区切りより前になるため、ズレの大きさが分かる */
    observedAt: string
}

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
    /** 1日ごとの区切り。1日を超える枠でだけ入り、記録が無ければ空配列 */
    dayMarks?: AiUsageDayMark[]
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
}

export interface AiUsageSnapshot {
    providers: AiProviderUsage[]
    /** 各提供元へ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
