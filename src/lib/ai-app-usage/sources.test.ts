import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import {
    AiAppUsageSourcesError,
    getAiAppUsageSources,
    parseSources,
    saveAiAppUsageSources,
} from "@/lib/ai-app-usage/sources"

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

describe("アプリ別AI利用の連携先設定", () => {
    it("初回だけ旧環境変数を永続ファイルへ移し、以後はファイルを正とする", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        const previous = process.env.AI_APP_USAGE_SOURCES
        process.env.AI_APP_USAGE_SOURCES = JSON.stringify([{ app: "legacy", url: "https://legacy.example/api/ai-usage" }])
        t.after(() => {
            if (previous === undefined) delete process.env.AI_APP_USAGE_SOURCES
            else process.env.AI_APP_USAGE_SOURCES = previous
        })

        assert.deepEqual(await getAiAppUsageSources(), {
            sources: [{ app: "legacy", url: "https://legacy.example/api/ai-usage" }],
            error: null,
        })
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ app: "legacy", url: "https://legacy.example/api/ai-usage" }])

        process.env.AI_APP_USAGE_SOURCES = "[]"
        assert.deepEqual(await getAiAppUsageSources(), {
            sources: [{ app: "legacy", url: "https://legacy.example/api/ai-usage" }],
            error: null,
        })
    })

    it("検証済みの一覧だけを保存し、不正な値で既存設定を壊さない", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        const saved = await saveAiAppUsageSources([{ app: "aide", url: "https://aide.example/api/ai-usage" }])
        assert.deepEqual(saved, [{ app: "aide", url: "https://aide.example/api/ai-usage" }])

        await assert.rejects(
            saveAiAppUsageSources([{ app: "aide", url: "http://outside.example/api/ai-usage" }]),
            AiAppUsageSourcesError
        )
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ app: "aide", url: "https://aide.example/api/ai-usage" }])
    })
})
