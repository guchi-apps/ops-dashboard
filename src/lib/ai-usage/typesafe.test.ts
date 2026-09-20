import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseTypeSafeUsageResponse, TYPESAFE_INPUT_USD_PER_MILLION_TOKENS } from "@/lib/ai-usage/typesafe"

describe("parseTypeSafeUsageResponse", () => {
    it("直近24時間・7日間・用途別の実測値と概算金額を整形する", () => {
        const result = parseTypeSafeUsageResponse({
            last24h: { calls: 126, inputTokens: 42_800 },
            last7d: { calls: 642, inputTokens: 218_400 },
            features: [
                {
                    label: "モデル選択",
                    last24h: { calls: 126, inputTokens: 42_800 },
                    last7d: { calls: 642, inputTokens: 218_400 },
                },
            ],
        })

        assert.deepEqual(result, {
            last24h: {
                calls: 126,
                inputTokens: 42_800,
                estimatedCostUsd: (42_800 * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
            },
            last7d: {
                calls: 642,
                inputTokens: 218_400,
                estimatedCostUsd: (218_400 * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
            },
            features: [
                {
                    label: "モデル選択",
                    last24h: {
                        calls: 126,
                        inputTokens: 42_800,
                        estimatedCostUsd: (42_800 * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
                    },
                    last7d: {
                        calls: 642,
                        inputTokens: 218_400,
                        estimatedCostUsd: (218_400 * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
                    },
                },
            ],
        })
    })

    it("合計が欠ける・負数・小数の応答は採用しない", () => {
        assert.equal(parseTypeSafeUsageResponse({}), null)
        assert.equal(
            parseTypeSafeUsageResponse({
                last24h: { calls: -1, inputTokens: 10 },
                last7d: { calls: 1, inputTokens: 10 },
            }),
            null
        )
        assert.equal(
            parseTypeSafeUsageResponse({
                last24h: { calls: 1.5, inputTokens: 10 },
                last7d: { calls: 1, inputTokens: 10 },
            }),
            null
        )
    })

    it("不正な用途別内訳は捨て、合計が正しければ表示を続ける", () => {
        const result = parseTypeSafeUsageResponse({
            last24h: { calls: 1, inputTokens: 10 },
            last7d: { calls: 2, inputTokens: 20 },
            features: [
                { label: "", last24h: { calls: 1, inputTokens: 10 }, last7d: { calls: 2, inputTokens: 20 } },
                { label: "モデル選択", last24h: { calls: 1, inputTokens: 10 }, last7d: { calls: 2, inputTokens: 20 } },
            ],
        })

        assert.deepEqual(result?.features.map((feature) => feature.label), ["モデル選択"])
    })
})
