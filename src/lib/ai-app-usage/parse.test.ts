import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseAiAppUsageResponse } from "@/lib/ai-app-usage/parse"

function feature(overrides: Record<string, unknown> = {}) {
    return {
        label: "チャット",
        model: "claude-opus-5",
        last24h: { calls: 2, inputTokens: 1_000_000, outputTokens: 100_000 },
        last7d: { calls: 10, inputTokens: 5_000_000, outputTokens: 500_000 },
        ...overrides,
    }
}

describe("parseAiAppUsageResponse", () => {
    it("機能ごとの集計を読み、金額は単価表から計算する", () => {
        const result = parseAiAppUsageResponse({ features: [feature()] })

        assert.ok(result)
        assert.equal(result.length, 1)
        assert.equal(result[0].label, "チャット")
        assert.equal(result[0].model, "claude-opus-5")
        assert.deepEqual(result[0].last24h, { calls: 2, inputTokens: 1_000_000, outputTokens: 100_000, costUsd: 7.5 })
    })

    it("入力はキャッシュの書き込み・読み出しを含めた合計で出し、金額は各単価で換算する", () => {
        const result = parseAiAppUsageResponse({
            features: [
                feature({
                    last24h: {
                        calls: 1,
                        inputTokens: 100,
                        outputTokens: 0,
                        cacheReadTokens: 2_000_000,
                        cacheWriteTokens: 400_000,
                    },
                }),
            ],
        })

        assert.ok(result)
        assert.equal(result[0].last24h.inputTokens, 100 + 2_000_000 + 400_000)
        assert.ok(result[0].last24h.costUsd !== null && Math.abs(result[0].last24h.costUsd - 3.500_5) < 1e-9)
    })

    it("出力トークンを省略した行は「数えていない」（null）として読む", () => {
        const result = parseAiAppUsageResponse({
            features: [
                feature({
                    model: "jev",
                    last24h: { calls: 3, inputTokens: 1_000_000 },
                    last7d: { calls: 3, inputTokens: 1_000_000 },
                }),
            ],
        })

        assert.ok(result)
        assert.equal(result[0].last24h.outputTokens, null)
        assert.equal(result[0].last24h.costUsd, 0.042)
    })

    it("機能が0件の応答は、呼び出しが無かっただけの正常な応答", () => {
        assert.deepEqual(parseAiAppUsageResponse({ features: [] }), [])
    })

    it("形が違う応答は採用しない（1行でも違えば全体を捨てる）", () => {
        assert.equal(parseAiAppUsageResponse(null), null)
        assert.equal(parseAiAppUsageResponse({}), null)
        assert.equal(parseAiAppUsageResponse({ features: {} }), null)
        assert.equal(parseAiAppUsageResponse({ features: [feature(), { label: "x" }] }), null)
        assert.equal(parseAiAppUsageResponse({ features: [feature({ label: "" })] }), null)
        assert.equal(parseAiAppUsageResponse({ features: [feature({ model: 1 })] }), null)
    })

    it("負数・小数・文字列のトークン数や、片方の期間の欠けは採用しない", () => {
        const bad = (last24h: unknown) => parseAiAppUsageResponse({ features: [feature({ last24h })] })

        assert.equal(bad({ calls: -1, inputTokens: 1 }), null)
        assert.equal(bad({ calls: 1.5, inputTokens: 1 }), null)
        assert.equal(bad({ calls: 1, inputTokens: "10" }), null)
        assert.equal(bad({ calls: 1, inputTokens: 1, outputTokens: -5 }), null)
        assert.equal(bad({ calls: 1, inputTokens: 1, cacheReadTokens: null }), null)
        assert.equal(parseAiAppUsageResponse({ features: [feature({ last7d: undefined })] }), null)
    })
})
