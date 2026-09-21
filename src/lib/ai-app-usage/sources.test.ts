import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseSources } from "@/lib/ai-app-usage/sources"

describe("parseSources", () => {
    it("未設定・空文字は連携先なし（エラーにしない）", () => {
        assert.deepEqual(parseSources(undefined), { sources: [], error: null })
        assert.deepEqual(parseSources("  "), { sources: [], error: null })
    })

    it("https と、同じホスト内のループバックのhttpを読む", () => {
        const { sources, error } = parseSources(
            JSON.stringify([
                { app: "aide-bot", url: "https://bot.example.com/api/ai-usage" },
                { app: "asset-manager", url: "http://127.0.0.1:3090/api/ai-usage" },
            ])
        )

        assert.equal(error, null)
        assert.deepEqual(
            sources.map((source) => source.app),
            ["aide-bot", "asset-manager"]
        )
    })

    it("トークンを平文で送ることになるため、外部ホストのhttpは受け付けない", () => {
        const { sources, error } = parseSources(JSON.stringify([{ app: "a", url: "http://bot.example.com/x" }]))

        assert.deepEqual(sources, [])
        assert.ok(error)
    })

    it("壊れたJSON・配列でない値・app や url の欠け・アプリ名の重複は、1件も採用せず理由を返す", () => {
        for (const raw of [
            "{",
            "{}",
            JSON.stringify([{ url: "https://x.example.com" }]),
            JSON.stringify([{ app: "a" }]),
            JSON.stringify([{ app: "a", url: "not a url" }]),
            JSON.stringify([
                { app: "a", url: "https://x.example.com" },
                { app: "a", url: "https://y.example.com" },
            ]),
        ]) {
            const result = parseSources(raw)
            assert.deepEqual(result.sources, [], raw)
            assert.ok(result.error, raw)
        }
    })
})
