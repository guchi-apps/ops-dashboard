import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sumTotals, summarizeApps, summarizeModels } from "@/lib/ai-app-usage/summarize"
import type { AiAppFeatureUsage, AiAppUsageApp, AiAppUsageTotals } from "@/types/ai-app-usage"

function totals(calls: number, overrides: Partial<AiAppUsageTotals> = {}): AiAppUsageTotals {
    return { calls, inputTokens: calls * 100, outputTokens: calls * 10, costUsd: calls / 100, ...overrides }
}

function feature(label: string, model: string, last24h: AiAppUsageTotals, last7d = last24h): AiAppFeatureUsage {
    return { label, model, last24h, last7d }
}

function app(name: string, features: AiAppFeatureUsage[], status: AiAppUsageApp["status"] = "ok"): AiAppUsageApp {
    return { app: name, status, features }
}

describe("sumTotals", () => {
    it("入力トークンを数えていない行は、数えた行だけを足して不完全と記す", () => {
        const none = { inputTokens: null, outputTokens: null, costUsd: null }
        const mixed = sumTotals([totals(1, none), totals(2)])
        assert.equal(mixed.inputTokens, 200)
        assert.equal(mixed.inputIncomplete, true)
        // トークン未集計の行の金額なしは、単価不明（costIncomplete）とは区別する
        assert.equal(mixed.costIncomplete, false)

        const allNone = sumTotals([totals(1, none)])
        assert.equal(allNone.inputTokens, null)
        assert.equal(allNone.calls, 1)
    })

    it("モデルを切り替えた期間は、行ごとの金額を足し、単価不明の行があれば不完全と記す（#418）", () => {
        // parse が行ごとに換算した金額（gpt-5.6-sol と gpt-6-sol）を合計する
        const switched = sumTotals([totals(1, { costUsd: 4 }), totals(1, { costUsd: 2 })])
        assert.equal(switched.costUsd, 6)
        assert.equal(switched.costIncomplete, false)

        const unknown = sumTotals([totals(1, { costUsd: 4 }), totals(1, { costUsd: null })])
        assert.equal(unknown.costUsd, 4)
        assert.equal(unknown.costIncomplete, true)
    })

    it("回数・トークン・金額を足す", () => {
        const sum = sumTotals([totals(2), totals(3)])

        assert.deepEqual(sum, {
            calls: 5,
            inputTokens: 500,
            inputIncomplete: false,
            outputTokens: 50,
            costUsd: 0.05,
            costIncomplete: false,
        })
    })

    it("出力トークンを数えている行が無ければ null、金額を計算できない行が混じれば不完全と記す", () => {
        const sum = sumTotals([totals(1, { outputTokens: null, costUsd: null }), totals(2, { outputTokens: null })])

        assert.equal(sum.outputTokens, null)
        assert.equal(sum.costUsd, 0.02)
        assert.equal(sum.costIncomplete, true)
    })

    it("金額がどの行でも計算できなければ null（0円と区別する）", () => {
        assert.equal(sumTotals([totals(1, { costUsd: null })]).costUsd, null)
        assert.equal(sumTotals([]).costUsd, null)
    })
})

describe("summarizeApps", () => {
    const apps = [
        app("small", [feature("a", "claude-haiku-4-5", totals(3))]),
        app("broken", [], "error"),
        app("big", [
            feature("chat", "claude-opus-5", totals(10)),
            feature("brief", "claude-haiku-4-5-20251001", totals(4)),
            feature("chat2", "claude-opus-5", totals(6)),
        ]),
    ]

    it("取得できたアプリを呼出回数の多い順に、取得できなかったアプリを末尾に並べる", () => {
        assert.deepEqual(
            summarizeApps(apps, "last24h").map((summary) => summary.app.app),
            ["big", "small", "broken"]
        )
    })

    it("使用モデルは日付付きのIDを寄せて、呼出回数の多い順に数える", () => {
        const big = summarizeApps(apps, "last24h")[0]

        assert.deepEqual(big.models, [
            { model: "claude-opus-5", calls: 16 },
            { model: "claude-haiku-4-5", calls: 4 },
        ])
    })

    it("期間内に呼び出しの無いモデルはチップに出さない", () => {
        const only7d = [app("x", [feature("f", "claude-opus-5", totals(0), totals(9))])]

        assert.deepEqual(summarizeApps(only7d, "last24h")[0].models, [])
        assert.deepEqual(summarizeApps(only7d, "last7d")[0].models, [{ model: "claude-opus-5", calls: 9 }])
    })
})

describe("summarizeModels", () => {
    it("モデルごとに、使っているアプリを呼出回数の多い順に返し、取得できなかったアプリは含めない", () => {
        const models = summarizeModels(
            [
                app("a", [feature("f", "claude-opus-5", totals(2))]),
                app("b", [feature("f", "claude-opus-5", totals(5)), feature("g", "jev", totals(1))]),
                app("broken", [feature("f", "claude-opus-5", totals(100))], "error"),
            ],
            "last24h"
        )

        assert.deepEqual(models, [
            { model: "claude-opus-5", calls: 7, apps: ["b", "a"] },
            { model: "jev", calls: 1, apps: ["b"] },
        ])
    })
})
