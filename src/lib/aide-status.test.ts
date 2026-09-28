import assert from "node:assert/strict"
import { afterEach, describe, it, mock } from "node:test"
import { getAideStatusSnapshot, isAideStatusConfigured, runAideStatusChecks } from "@/lib/aide-status"

/**
 * ここでは issue-deck の共有トークンAPI（`ISSUE_DECK_URL`・`SHARED_TOKEN_API_SECRET`）を
 * 常に未設定にして、フォールバック用の `AIDE_STATUS_TOKEN` だけが効く経路を確かめる。
 * 共有トークンAPI自体のキャッシュ・失敗時の挙動は `shared-token.test.ts` で確かめている
 * （プロセス内キャッシュを持つモジュールのため、設定を切り替えるテストを混ぜると
 * 前のテストのキャッシュが残ってしまう）。
 */

const ENV_KEYS = ["AIDE_STATUS_TOKEN", "AIDE_BASE_URL", "ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET"] as const

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value

    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    return mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init))
    )
}

const goodStatusPayload = {
    health: {
        severity: "ok",
        attention: [],
        jobs: [],
        connectors: [],
        server: {},
        cache: {},
        mcp: {},
        mcpAccess: {},
    },
    tools: ["weather"],
}

afterEach(() => mock.restoreAll())

describe("isAideStatusConfigured", () => {
    it("共有トークンAPI・フォールバック用トークンのいずれも無ければfalse", () => {
        const restore = setEnv({})
        try {
            assert.equal(isAideStatusConfigured(), false)
        } finally {
            restore()
        }
    })

    it("フォールバック用のAIDE_STATUS_TOKENだけでもtrue", () => {
        const restore = setEnv({ AIDE_STATUS_TOKEN: "legacy-token" })
        try {
            assert.equal(isAideStatusConfigured(), true)
        } finally {
            restore()
        }
    })

    it("共有トークンAPIの設定（URL・secret）だけでもtrue", () => {
        const restore = setEnv({ ISSUE_DECK_URL: "https://issuedeck.example", SHARED_TOKEN_API_SECRET: "secret" })
        try {
            assert.equal(isAideStatusConfigured(), true)
        } finally {
            restore()
        }
    })

    it("共有トークンAPIのURL・secretの片方だけではfalse", () => {
        const restore = setEnv({ ISSUE_DECK_URL: "https://issuedeck.example" })
        try {
            assert.equal(isAideStatusConfigured(), false)
        } finally {
            restore()
        }
    })
})

describe("getAideStatusSnapshot: フォールバック", () => {
    it("共有トークンAPIが未設定なら、AIDE_STATUS_TOKENでAIDEへ問い合わせる", async () => {
        const restore = setEnv({ AIDE_STATUS_TOKEN: "legacy-token" })
        try {
            const fetchMock = stubFetch(() => Response.json(goodStatusPayload))

            const snapshot = await getAideStatusSnapshot()

            assert.equal(snapshot.status, "ok")
            assert.equal(snapshot.tools[0], "weather")
            const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
            assert.equal(url, "http://127.0.0.1:3114/api/status")
            assert.equal((init.headers as Record<string, string>).authorization, "Bearer legacy-token")
        } finally {
            restore()
        }
    })

    it("両方とも未設定ならAIDEへ問い合わせず未設定を返す", async () => {
        const restore = setEnv({})
        try {
            const fetchMock = stubFetch(() => Response.json(goodStatusPayload))

            const snapshot = await getAideStatusSnapshot()

            assert.equal(snapshot.status, "unconfigured")
            assert.equal(fetchMock.mock.calls.length, 0)
        } finally {
            restore()
        }
    })
})

describe("runAideStatusChecks: フォールバック", () => {
    it("共有トークンAPIが未設定ならAIDE_STATUS_TOKENを使う", async () => {
        const restore = setEnv({ AIDE_STATUS_TOKEN: "legacy-token" })
        try {
            stubFetch(() => Response.json({ results: [{ name: "internet", ok: true }] }))

            const result = await runAideStatusChecks()

            assert.equal(result.status, "ok")
            assert.equal(result.results.length, 1)
        } finally {
            restore()
        }
    })

    it("両方とも未設定なら未設定を返す", async () => {
        const restore = setEnv({})
        try {
            const result = await runAideStatusChecks()
            assert.equal(result.status, "unconfigured")
        } finally {
            restore()
        }
    })
})
