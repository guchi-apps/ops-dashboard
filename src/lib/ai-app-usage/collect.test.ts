import assert from "node:assert/strict"
import { afterEach, describe, it, mock } from "node:test"
import { collectAiAppUsage, TYPESAFE_APP_NAME, typeSafeAppFromUsage } from "@/lib/ai-app-usage/collect"
import type { AiProviderUsage } from "@/types/ai-usage"

afterEach(() => mock.restoreAll())

const goodBody = {
    features: [
        {
            label: "チャット",
            model: "claude-opus-5",
            last24h: { calls: 1, inputTokens: 10, outputTokens: 1 },
            last7d: { calls: 2, inputTokens: 20, outputTokens: 2 },
        },
    ],
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    return mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init))
    )
}

function typesafeUsage(overrides: Partial<AiProviderUsage> = {}): AiProviderUsage {
    const totals = (calls: number, inputTokens: number) => ({ calls, inputTokens, estimatedCostUsd: 0 })
    return {
        id: "typesafe",
        name: "TypeSafe AI",
        plan: "Jev",
        status: "ok",
        windows: [],
        metered: {
            last24h: totals(3, 1_000_000),
            last7d: totals(9, 3_000_000),
            features: [{ label: "Issueの要約", last24h: totals(3, 1_000_000), last7d: totals(9, 3_000_000) }],
        },
        ...overrides,
    }
}

describe("collectAiAppUsage", () => {
    it("連携先へBearerトークンを付けて読み、アプリ名と機能を返す", async () => {
        const fetchMock = stubFetch(() => Response.json(goodBody))

        const apps = await collectAiAppUsage({
            sources: [{ app: "aide-bot", url: "https://bot.example.com/api/ai-usage" }],
            token: "secret-token",
            typesafe: null,
        })

        assert.equal(apps.length, 1)
        assert.equal(apps[0].app, "aide-bot")
        assert.equal(apps[0].status, "ok")
        assert.equal(apps[0].features[0].model, "claude-opus-5")
        const init = fetchMock.mock.calls[0].arguments[1] as RequestInit
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-token")
    })

    it("失敗は理由つきの取得不可にする。トークンやURLは理由へ含めない", async () => {
        mock.method(globalThis, "fetch", (input: string | URL | Request) => {
            const url = String(input)
            if (url.includes("gone")) return Promise.reject(new Error(`connect ECONNREFUSED ${url}`))
            if (url.includes("down")) return Promise.resolve(new Response("boom", { status: 500 }))
            return Promise.resolve(Response.json({ nope: true }))
        })

        const apps = await collectAiAppUsage({
            sources: [
                { app: "down", url: "https://down.example.com/x" },
                { app: "odd", url: "https://odd.example.com/x" },
                { app: "gone", url: "https://gone.example.com/x" },
            ],
            token: "secret-token",
            typesafe: null,
        })

        assert.deepEqual(
            apps.map((app) => [app.app, app.status, app.message]),
            [
                ["down", "error", "HTTP 500"],
                ["odd", "error", "応答の形式が想定と異なります"],
                ["gone", "error", "接続できません"],
            ]
        )
        assert.ok(apps.every((app) => app.features.length === 0))
    })

    it("トークンが無ければ連携先へは問い合わせない", async () => {
        const fetchMock = stubFetch(() => Response.json(goodBody))

        const apps = await collectAiAppUsage({
            sources: [{ app: "aide-bot", url: "https://bot.example.com/x" }],
            token: undefined,
            typesafe: null,
        })

        assert.deepEqual(apps, [])
        assert.equal(fetchMock.mock.callCount(), 0)
    })

    it("issue-deckの連携先が無ければ、既存のTypeSafeの結果をJevの行として補う", async () => {
        const apps = await collectAiAppUsage({ sources: [], token: "t", typesafe: typesafeUsage() })

        assert.equal(apps.length, 1)
        assert.equal(apps[0].app, TYPESAFE_APP_NAME)
        assert.equal(apps[0].features[0].model, "jev")
        assert.equal(apps[0].features[0].last24h.outputTokens, null)
        assert.equal(apps[0].features[0].last24h.costUsd, 0.042)
    })

    it("issue-deck自身の連携先があるときは、Jevの分を二重に数えない", async () => {
        stubFetch(() => Response.json(goodBody))

        const apps = await collectAiAppUsage({
            sources: [{ app: TYPESAFE_APP_NAME, url: "https://deck.example.com/x" }],
            token: "t",
            typesafe: typesafeUsage(),
        })

        assert.equal(apps.length, 1)
        assert.equal(apps[0].features[0].model, "claude-opus-5")
    })
})

describe("typeSafeAppFromUsage", () => {
    it("未設定なら一覧に出さない", () => {
        assert.equal(typeSafeAppFromUsage(typesafeUsage({ status: "unconfigured", metered: undefined })), null)
    })

    it("取得に失敗していれば、理由つきの取得不可にする", () => {
        const app = typeSafeAppFromUsage(typesafeUsage({ status: "error", message: "HTTP 401", metered: undefined }))

        assert.deepEqual(app, { app: TYPESAFE_APP_NAME, status: "error", message: "HTTP 401", features: [] })
    })
})
