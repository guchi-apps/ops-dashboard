import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { describe, it, mock } from "node:test"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import {
    AiAppUsageSourcesError,
    getAiAppUsageSources,
    parseSources,
    parseSourceValues,
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
                { app: "aide-bot", url: "https://bot.gucchii.com/api/ai-usage" },
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

    it("許可ホスト以外のhttpsは、保存時も読み込み時も受け付けない（#465）", () => {
        for (const url of [
            "https://attacker.example/",
            "https://gucchii.com.attacker.example/",
            "https://notgucchii.com/",
            "https://gucchii.com@attacker.example/",
        ]) {
            const { sources, error } = parseSourceValues([{ app: "x", url }])
            assert.deepEqual(sources, [], url)
            assert.ok(error, url)
        }
    })

    it("AI_APP_USAGE_ALLOWED_HOSTS で許可ホストを足せる", () => {
        const before = process.env.AI_APP_USAGE_ALLOWED_HOSTS
        process.env.AI_APP_USAGE_ALLOWED_HOSTS = "exact.example, *.wild.example"
        try {
            const ok = parseSourceValues([
                { app: "a", url: "https://exact.example/x" },
                { app: "b", url: "https://sub.wild.example/x" },
            ])
            assert.equal(ok.error, null)
            assert.ok(parseSourceValues([{ app: "c", url: "https://sub.exact.example/x" }]).error)
            assert.ok(parseSourceValues([{ app: "d", url: "https://wild.example/x" }]).error)
        } finally {
            if (before === undefined) delete process.env.AI_APP_USAGE_ALLOWED_HOSTS
            else process.env.AI_APP_USAGE_ALLOWED_HOSTS = before
        }
    })

    it("壊れたJSON・配列でない値・app や url の欠け・アプリ名の重複は、1件も採用せず理由を返す", () => {
        for (const raw of [
            "{",
            "{}",
            JSON.stringify([{ url: "https://x.gucchii.com" }]),
            JSON.stringify([{ app: "a" }]),
            JSON.stringify([{ app: "a", url: "not a url" }]),
            JSON.stringify([
                { app: "a", url: "https://x.gucchii.com" },
                { app: "a", url: "https://y.gucchii.com" },
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
        process.env.AI_APP_USAGE_SOURCES = JSON.stringify([{ app: "legacy", url: "https://legacy.gucchii.com/api/ai-usage" }])
        t.after(() => {
            if (previous === undefined) delete process.env.AI_APP_USAGE_SOURCES
            else process.env.AI_APP_USAGE_SOURCES = previous
        })

        assert.deepEqual(await getAiAppUsageSources(), {
            sources: [{ app: "legacy", url: "https://legacy.gucchii.com/api/ai-usage" }],
            error: null,
        })
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ app: "legacy", url: "https://legacy.gucchii.com/api/ai-usage" }])

        process.env.AI_APP_USAGE_SOURCES = "[]"
        assert.deepEqual(await getAiAppUsageSources(), {
            sources: [{ app: "legacy", url: "https://legacy.gucchii.com/api/ai-usage" }],
            error: null,
        })
    })

    it("壊れた旧設定はスキップして空の一覧を保存し、画面から登録し直せる", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        const previous = process.env.AI_APP_USAGE_SOURCES
        const warning = mock.method(console, "warn", () => undefined)
        t.after(() => {
            warning.mock.restore()
            if (previous === undefined) delete process.env.AI_APP_USAGE_SOURCES
            else process.env.AI_APP_USAGE_SOURCES = previous
        })

        process.env.AI_APP_USAGE_SOURCES = "{"
        assert.deepEqual(await getAiAppUsageSources(), { sources: [], error: null })
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [])
        assert.equal(warning.mock.callCount(), 1)
        assert.match(warning.mock.calls[0].arguments[0], /AI_APP_USAGE_SOURCES がJSONとして読めません/)

        const saved = [{ app: "aide", url: "https://aide.gucchii.com/api/ai-usage" }]
        await saveAiAppUsageSources(saved)
        assert.deepEqual(await getAiAppUsageSources(), { sources: saved, error: null })
        assert.equal(warning.mock.callCount(), 1)
    })

    it("保存済みファイルが壊れている場合はエラーを維持する", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        writeFileSync(file, "{")
        assert.deepEqual(await getAiAppUsageSources(), {
            sources: [],
            error: "連携先の設定ファイルがJSONとして読めません",
        })
    })

    it("検証済みの一覧だけを保存し、不正な値で既存設定を壊さない", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        const saved = await saveAiAppUsageSources([{ app: "aide", url: "https://aide.gucchii.com/api/ai-usage" }])
        assert.deepEqual(saved, [{ app: "aide", url: "https://aide.gucchii.com/api/ai-usage" }])

        await assert.rejects(
            saveAiAppUsageSources([{ app: "aide", url: "http://outside.example/api/ai-usage" }]),
            AiAppUsageSourcesError
        )
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ app: "aide", url: "https://aide.gucchii.com/api/ai-usage" }])
    })

    it("複数の連携先を保存し、片方を削除した一覧で置き換えられる", async (t) => {
        const file = redirectStateFile(t, "AI_APP_USAGE_SOURCES_PATH")
        const saved = await saveAiAppUsageSources([
            { app: "issue-deck", url: "https://issue-deck.gucchii.com/api/ai-usage" },
            { app: "aide", url: "https://aide.gucchii.com/api/ai-usage" },
        ])
        assert.equal(saved.length, 2)

        await saveAiAppUsageSources(saved.filter((source) => source.app !== "issue-deck"))
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [{ app: "aide", url: "https://aide.gucchii.com/api/ai-usage" }])
    })
})
