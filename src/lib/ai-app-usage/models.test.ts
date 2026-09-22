import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canonicalModelId, estimateCostUsd, findModel, modelLabel } from "@/lib/ai-app-usage/models"
import { TYPESAFE_INPUT_USD_PER_MILLION_TOKENS } from "@/lib/ai-usage/typesafe"

const NONE = { cacheReadTokens: 0, cacheWriteTokens: 0 }

describe("findModel", () => {
    it("日付付きのIDや派生名も同じモデルとして引く", () => {
        assert.equal(findModel("claude-haiku-4-5-20251001")?.id, "claude-haiku-4-5")
        assert.equal(findModel("Jev-1")?.id, "jev")
        assert.equal(canonicalModelId("claude-opus-5"), "claude-opus-5")
    })

    it("前方一致は区切りの - を挟むものだけ（別のモデル名を巻き込まない）", () => {
        assert.equal(findModel("claude-opus-50"), null)
        assert.equal(findModel("jevons"), null)
    })

    it("別モデルのIDへの前方一致にはならず、完全一致するモデルとして引ける（#362）", () => {
        // "claude-opus-5-5"（Opus 5.5）は "claude-opus-5"（Opus 5）への前方一致にも
        // 当てはまってしまう文字列だが、別モデルとして単価が異なるため巻き込んではいけない
        assert.equal(findModel("claude-opus-5-5")?.id, "claude-opus-5-5")
        assert.equal(findModel("claude-opus-5")?.id, "claude-opus-5")
    })

    it("一覧に無いモデルは名前をそのまま出し、集計のキーも変えない", () => {
        assert.equal(findModel("gpt-9"), null)
        assert.equal(modelLabel("gpt-9"), "gpt-9")
        assert.equal(canonicalModelId("gpt-9"), "gpt-9")
    })
})

describe("estimateCostUsd", () => {
    it("入力・出力・キャッシュをそれぞれの単価で換算する", () => {
        // Opus 5: 入力 $5 / 出力 $25 / 書き込み $6.25 / 読み出し $0.5（100万トークンあたり）
        const cost = estimateCostUsd("claude-opus-5", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(cost !== null)
        assert.ok(Math.abs(cost - (5 + 2.5 + 1 + 2.5)) < 1e-9)
    })

    it("Opus 5.5は別単価（Opus 5より安い）として計算する（#362）", () => {
        // Opus 5.5: 入力 $4 / 出力 $20 / 書き込み $5 / 読み出し $0.2（100万トークンあたり）
        const cost = estimateCostUsd("claude-opus-5-5", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(cost !== null)
        assert.ok(Math.abs(cost - (4 + 2 + 0.4 + 2)) < 1e-9)
    })

    it("単価に無いモデルは推測せず null", () => {
        assert.equal(estimateCostUsd("gpt-9", { inputTokens: 10, outputTokens: 10, ...NONE }), null)
    })

    it("出力が有料のモデルで出力トークンが不明なら、入力だけの金額を出さず null", () => {
        assert.equal(estimateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: null, ...NONE }), null)
    })

    it("Jevは出力が無料なので、出力トークンが不明でも入力単価だけで計算できる", () => {
        assert.equal(
            estimateCostUsd("jev", { inputTokens: 1_000_000, outputTokens: null, ...NONE }),
            TYPESAFE_INPUT_USD_PER_MILLION_TOKENS
        )
    })
})
