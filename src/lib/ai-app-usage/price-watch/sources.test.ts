import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
    parseAnthropicModelIds,
    parseAnthropicPricing,
    parseOpenAiPricing,
    PriceParseError,
} from "@/lib/ai-app-usage/price-watch/sources"

const OPENAI_HEAD =
    "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |"

/** Standard・Batch は同じ列構成の別の節。Batch のほうは単価が半額 */
const OPENAI = `# Pricing

### Standard pricing data

${OPENAI_HEAD}
| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.2 | $1.75 | $0.175 | - | $14.00 | - | - | - | - |
| gpt-broken | contact sales | - | - | - | - | - | - | - |

### Batch pricing data

${OPENAI_HEAD}
| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |
`

describe("parseOpenAiPricing", () => {
    it("Standardの節の表だけを読み、Batchなど別の節の単価を混ぜない", () => {
        const { prices } = parseOpenAiPricing(OPENAI)
        const sol = prices.find((entry) => entry.id === "gpt-6-sol")
        assert.deepEqual(sol?.price, { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 })
        assert.equal(prices.filter((entry) => entry.id === "gpt-6-sol").length, 1)
    })

    it("`-` は課金なし（null）で、0にしない", () => {
        const { prices } = parseOpenAiPricing(OPENAI)
        const old = prices.find((entry) => entry.id === "gpt-5.2")
        assert.equal(old?.price?.cacheWrite, null)
        assert.equal(old?.price?.cacheRead, 0.175)
    })

    it("条件付きの行は、通常価格として取り込まない", () => {
        const entry = parseOpenAiPricing(OPENAI).prices.find((item) => item.id === "gpt-5.5")
        assert.equal(entry?.price, null)
        assert.equal(entry?.condition, "<272K context length")
    })

    it("読めない行は読み飛ばして知らせる", () => {
        const { prices, warnings } = parseOpenAiPricing(OPENAI)
        assert.equal(prices.some((entry) => entry.id === "gpt-broken"), false)
        assert.equal(warnings.length, 1)
    })

    it("Standardの節や列見出しが想定と違うときは失敗にする", () => {
        assert.throws(() => parseOpenAiPricing(OPENAI.replace("### Standard pricing data", "### Other")), PriceParseError)
        assert.throws(() => parseOpenAiPricing(OPENAI.replace("Short context input", "Input")), PriceParseError)
    })
})

const ANTHROPIC = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://example.com/glasswing)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 4 ([retired, except on Google Cloud](https://example.com/dep)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |

## Cloud platform pricing
`

const MODELS = `| | A | B |
| :--- | :--- | :--- |
| Model page | [Claude Fable 5.1](https://example.com/a) | [Claude Opus 5.5](https://example.com/b) |
| Claude API ID | \`claude-fable-5-1\` | \`claude-opus-5-5\` |
`

describe("parseAnthropicModelIds", () => {
    it("表示名からAPIのモデルIDを作る", () => {
        const ids = parseAnthropicModelIds(MODELS)
        assert.equal(ids.get("Claude Fable 5.1"), "claude-fable-5-1")
        assert.equal(ids.get("Claude Opus 5.5"), "claude-opus-5-5")
    })

    it("表が見つからなければ失敗にする", () => {
        assert.throws(() => parseAnthropicModelIds("| a | b |\n"), PriceParseError)
    })
})

describe("parseAnthropicPricing", () => {
    const ids = parseAnthropicModelIds(MODELS)

    it("脚注を除いて単価を読み、キャッシュ書き込みは5分のものを使う", () => {
        const fable = parseAnthropicPricing(ANTHROPIC, ids).prices.find((entry) => entry.name === "Claude Fable 5.1")
        assert.equal(fable?.id, "claude-fable-5-1")
        assert.deepEqual(fable?.price, { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 })
        const sonnet = parseAnthropicPricing(ANTHROPIC, ids).prices.find((entry) => entry.name === "Claude Sonnet 5")
        assert.equal(sonnet?.price?.input, 2)
    })

    it("IDを確かめられないモデルは null のまま（表示名から推測しない）", () => {
        const sonnet = parseAnthropicPricing(ANTHROPIC, ids).prices.find((entry) => entry.name === "Claude Sonnet 5")
        assert.equal(sonnet?.id, null)
    })

    it("限定提供・提供終了の注記を条件として持つ", () => {
        const { prices } = parseAnthropicPricing(ANTHROPIC, ids)
        assert.equal(prices.find((entry) => entry.name === "Claude Mythos 5.1")?.condition, "限定提供（招待制）")
        const retired = prices.find((entry) => entry.name === "Claude Opus 4")
        assert.equal(retired?.retired, true)
    })

    it("列見出しが想定と違えば失敗にする", () => {
        assert.throws(() => parseAnthropicPricing(ANTHROPIC.replace("5m cache writes", "Cache writes"), ids), PriceParseError)
    })
})
