/**
 * アプリごとのAI利用（#325）。
 *
 * 連携先のアプリが返す集計（`AiAppFeatureUsage` の元になる応答の形は README を参照）を
 * サーバーで検証・金額換算し、画面へ渡す形。提供元ごとの利用枠（`ai-usage.ts`）とは別の軸で、
 * 「どのアプリが、どのモデルで、どれだけ使ったか」を表す。
 */

/** 1つの期間（24時間・7日間）の集計 */
export interface AiAppUsageTotals {
    /** 呼出回数 */
    calls: number
    /** 入力ぶんのトークン数の合計。キャッシュの書き込み・読み出しを含む */
    inputTokens: number
    /** 出力トークン数。連携先が数えていなければ null */
    outputTokens: number | null
    /** 単価表から計算したUSDの概算。単価の分からないモデルなど、計算できなければ null */
    costUsd: number | null
}

/** アプリの機能1つ×モデル1つの集計 */
export interface AiAppFeatureUsage {
    /** 機能の表示名（例: "チャット"） */
    label: string
    /** モデルの識別子（例: "claude-opus-5"）。連携先が返した値のまま */
    model: string
    last24h: AiAppUsageTotals
    last7d: AiAppUsageTotals
}

/**
 * ok    — 取得できた（機能が0件でも、呼び出しが無かっただけで取得はできている）
 * error — 連携先が設定されているのに取得できなかった。合計へは含めない
 */
export type AiAppUsageStatus = "ok" | "error"

export interface AiAppUsageApp {
    /** アプリ名（例: "aide-bot"） */
    app: string
    status: AiAppUsageStatus
    /** status が error のときに画面へ出す短い理由。トークンやURLは含めない */
    message?: string
    features: AiAppFeatureUsage[]
}

export interface AiAppUsageSnapshot {
    apps: AiAppUsageApp[]
    /** 連携先へ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}

/** 集計する期間。{@link AiAppFeatureUsage} のキーと同じ */
export type AiAppPeriod = "last24h" | "last7d"
