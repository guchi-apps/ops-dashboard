/**
 * アプリが使うモデルの表示名・提供元・単価（#325）。
 *
 * 画面（クライアント）からも読むため、サーバー専用の処理を import しないこと。
 */

/** 100万トークンあたりの単価（USD） */
export interface ModelPrice {
    input: number
    output: number
    /** プロンプトキャッシュへの書き込み */
    cacheWrite: number
    /** プロンプトキャッシュからの読み出し */
    cacheRead: number
}

/** 画面で色分けに使うモデルの系統 */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "jev"

export interface ModelInfo {
    /** 単価表のキー。連携先が日付付きのIDを返しても、ここへ寄せて数える */
    id: string
    label: string
    provider: string
    family: ModelFamily
    price: ModelPrice
}

/**
 * モデルの一覧と単価。
 *
 * **Anthropicが単価を変えたら、または連携先が新しいモデルを使い始めたらここを直す。**
 * 表に無いモデルは、名前だけを出して金額は「不明」にする（近いモデルの単価で推測すると、
 * 実際より安く見えたり高く見えたりするため）。
 * Claude系の単価は aide-bot の `MODEL_PRICING`（出典: https://claude.com/pricing#api）と同じ値。
 */
const MODELS: ModelInfo[] = [
    {
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        provider: "Anthropic",
        family: "opus",
        price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    },
    {
        id: "claude-opus-5",
        label: "Opus 5",
        provider: "Anthropic",
        family: "opus",
        price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    },
    {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        provider: "Anthropic",
        family: "sonnet",
        price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    },
    {
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
        provider: "Anthropic",
        family: "haiku",
        price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    },
    {
        // TypeSafe Jev。入力単価は typesafe.ts の TYPESAFE_INPUT_USD_PER_MILLION_TOKENS と同じ値
        // （テストで一致を確かめている）。出力トークンは現在無料のため 0
        id: "jev",
        label: "Jev",
        provider: "TypeSafe",
        family: "jev",
        price: { input: 0.042, output: 0, cacheWrite: 0, cacheRead: 0 },
    },
]

/**
 * モデルの識別子から一覧の1件を引く。
 *
 * 日付付きのID（`claude-haiku-4-5-20251001`）や Jev の派生名（`jev-1`）も同じモデルとして扱うため、
 * 完全一致のほかに「一覧のIDに `-` を足したものの先頭一致」を許す。**完全一致を全件先に確かめてから
 * 前方一致にフォールバックする。** 一段階の判定にすると、`claude-opus-5-5`（別モデル）が
 * `claude-opus-5` への前方一致で先に拾われてしまうように、短いIDのモデルが配列内で先にあるだけで
 * 後から登録した別モデルの単価を誤って被ってしまう（#362）。
 */
export function findModel(model: string): ModelInfo | null {
    const normalized = model.trim().toLowerCase()
    return (
        MODELS.find((info) => normalized === info.id) ??
        MODELS.find((info) => normalized.startsWith(`${info.id}-`)) ??
        null
    )
}

/** 集計のキーに使うモデルID。一覧にあれば一覧のID、無ければ連携先が返した値のまま */
export function canonicalModelId(model: string): string {
    return findModel(model)?.id ?? model
}

/** 画面に出すモデル名。一覧に無ければIDのまま */
export function modelLabel(model: string): string {
    return findModel(model)?.label ?? model
}

export interface TokenCounts {
    inputTokens: number
    /** 数えていなければ null */
    outputTokens: number | null
    cacheReadTokens: number
    cacheWriteTokens: number
}

/**
 * 単価表からの概算金額（USD）。計算できなければ null。
 *
 * - 単価が無いモデルは null（推測しない）
 * - 出力トークンが不明で、そのモデルの出力が有料なら null（入力だけの金額を全体の金額として
 *   出すと、実際より安く見えるため）
 */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
    const info = findModel(model)
    if (!info) return null

    const { price } = info
    if (tokens.outputTokens === null && price.output > 0) return null

    return (
        (tokens.inputTokens * price.input +
            (tokens.outputTokens ?? 0) * price.output +
            tokens.cacheReadTokens * price.cacheRead +
            tokens.cacheWriteTokens * price.cacheWrite) /
        1_000_000
    )
}
