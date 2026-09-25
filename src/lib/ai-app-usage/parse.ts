import { estimateCostUsd } from "@/lib/ai-app-usage/models"
import type { AiAppFeatureUsage, AiAppUsageTotals } from "@/types/ai-app-usage"

/**
 * 連携先のアプリが返す使用量APIの応答を検証して、画面用の形へ直す（#325）。
 *
 * 応答の形（各アプリが合わせる）:
 *
 *     { "features": [
 *         { "label": "チャット", "model": "claude-opus-5",
 *           "last24h": { "calls": 96, "inputTokens": 1420000, "outputTokens": 61000,
 *                        "cacheReadTokens": 0, "cacheWriteTokens": 0 },
 *           "last7d": { ... } } ] }
 *
 * `inputTokens`・`outputTokens`・`cacheReadTokens`・`cacheWriteTokens` は省略できる。省略した入力・出力トークンは
 * 「数えていない」（null。入力が null の行は金額も null）、キャッシュは 0 として扱う。
 * 機能の配列が空なのは「取得できたが呼び出しが無かった」で、エラーではない。
 */

interface RawTotals {
    calls?: unknown
    inputTokens?: unknown
    outputTokens?: unknown
    cacheReadTokens?: unknown
    cacheWriteTokens?: unknown
}

interface RawFeature {
    label?: unknown
    model?: unknown
    last24h?: unknown
    last7d?: unknown
}

/** 負でない整数だけを通す。小数・負数・文字列は形が違うものとして採用しない */
function readCount(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function toTotals(model: string, value: unknown): AiAppUsageTotals | null {
    if (!value || typeof value !== "object") return null
    const raw = value as RawTotals

    const calls = readCount(raw.calls)
    if (calls === null) return null

    // 入力トークンも省略（undefined）・null は「数えていない」（Codex CLIのようにトークン数を持たないアプリ）。
    // 値があるのに不正なものは応答ごと採用しない
    let inputTokens: number | null = null
    if (raw.inputTokens !== undefined && raw.inputTokens !== null) {
        inputTokens = readCount(raw.inputTokens)
        if (inputTokens === null) return null
    }

    // 省略（undefined）と null は「数えていない」。値があるのに不正なものは応答ごと採用しない
    let outputTokens: number | null = null
    if (raw.outputTokens !== undefined && raw.outputTokens !== null) {
        outputTokens = readCount(raw.outputTokens)
        if (outputTokens === null) return null
    }

    const cacheReadTokens = raw.cacheReadTokens === undefined ? 0 : readCount(raw.cacheReadTokens)
    const cacheWriteTokens = raw.cacheWriteTokens === undefined ? 0 : readCount(raw.cacheWriteTokens)
    if (cacheReadTokens === null || cacheWriteTokens === null) return null

    if (inputTokens === null) {
        // トークンを数えていない行は、キャッシュの内訳があっても金額を出さない（一部だけの金額になるため）
        return { calls, inputTokens: null, outputTokens, costUsd: null }
    }

    return {
        calls,
        // 画面に出す入力は、キャッシュに載った分も含めた合計（キャッシュを入れると
        // 「入力」だけが激減したように見えるため）
        inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
    }
}

/**
 * 応答を機能ごとの集計へ直す。形が想定と違えば null。
 *
 * 一部の行だけを捨てると、合計が黙って少なく出てしまう。そのため、1行でも形が違う応答は
 * 全体を採用せず、画面には「応答の形式が想定と異なります」を出す。
 */
export function parseAiAppUsageResponse(data: unknown): AiAppFeatureUsage[] | null {
    if (!data || typeof data !== "object") return null

    const features = (data as { features?: unknown }).features
    if (!Array.isArray(features)) return null

    const parsed: AiAppFeatureUsage[] = []
    for (const value of features) {
        if (!value || typeof value !== "object") return null
        const feature = value as RawFeature

        if (typeof feature.label !== "string" || feature.label.length === 0) return null
        if (typeof feature.model !== "string" || feature.model.length === 0) return null

        const last24h = toTotals(feature.model, feature.last24h)
        const last7d = toTotals(feature.model, feature.last7d)
        if (!last24h || !last7d) return null

        parsed.push({ label: feature.label, model: feature.model, last24h, last7d })
    }

    return parsed
}
