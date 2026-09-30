import assert from "node:assert/strict"
import { afterEach, describe, it, mock } from "node:test"
import { resolveSharedToken } from "@/lib/shared-token"

const ENV_KEYS = ["ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET"] as const

function setEnv(url: string | undefined, secret: string | undefined) {
    const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    if (url === undefined) delete process.env.ISSUE_DECK_URL
    else process.env.ISSUE_DECK_URL = url
    if (secret === undefined) delete process.env.SHARED_TOKEN_API_SECRET
    else process.env.SHARED_TOKEN_API_SECRET = secret

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

afterEach(() => mock.restoreAll())

describe("resolveSharedToken", () => {
    it("issue-deckから取得し、Bearerと利用元ヘッダーを付ける", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const fetchMock = stubFetch(() => Response.json({ name: "AIDE_STATUS_TOKEN", value: "token-1" }))

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 })

            assert.equal(result.value, "token-1")
            assert.deepEqual(result.cache, { value: "token-1", fetchedAtMs: 1_000 })
            const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
            assert.match(url, /\/api\/shared-tokens\?name=AIDE_STATUS_TOKEN$/)
            const headers = init.headers as Record<string, string>
            assert.equal(headers.authorization, "Bearer api-secret")
            assert.equal(headers["x-shared-token-consumer"], "ops-dashboard")
        } finally {
            restore()
        }
    })

    it("キャッシュが新しければ取得し直さない", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const fetchMock = stubFetch(() => Response.json({ value: "should-not-be-used" }))
            const cache = { value: "cached-token", fetchedAtMs: 1_000 }

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", cache, {
                now: 1_000 + 9 * 60 * 1000,
            })

            assert.equal(result.value, "cached-token")
            assert.deepEqual(result.cache, cache)
            assert.equal(fetchMock.mock.calls.length, 0)
        } finally {
            restore()
        }
    })

    it("キャッシュが10分を過ぎたら取得し直す", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const fetchMock = stubFetch(() => Response.json({ value: "fresh-token" }))
            const cache = { value: "stale-token", fetchedAtMs: 1_000 }

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", cache, {
                now: 1_000 + 10 * 60 * 1000 + 1,
            })

            assert.equal(result.value, "fresh-token")
            assert.equal(fetchMock.mock.calls.length, 1)
        } finally {
            restore()
        }
    })

    it("取得に失敗したら直前の値を使い続ける", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            stubFetch(() => new Response("error", { status: 500 }))
            const cache = { value: "last-good", fetchedAtMs: 1_000 }

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", cache, {
                now: 1_000 + 10 * 60 * 1000 + 1,
            })

            assert.equal(result.value, "last-good")
            assert.equal(result.failed, true)
            assert.deepEqual(result.cache, { ...cache, failedAtMs: 1_000 + 10 * 60 * 1000 + 1 })
        } finally {
            restore()
        }
    })

    it("失敗し、直前の値も無ければnullを返す", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            stubFetch(() => new Response("error", { status: 500 }))

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 })

            assert.equal(result.value, null)
            assert.equal(result.failed, true)
            assert.deepEqual(result.cache, { value: null, fetchedAtMs: 0, failedAtMs: 1_000 })
        } finally {
            restore()
        }
    })

    it("失敗の直後は取りにいかず、直前の値を即座に返す", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const fetchMock = stubFetch(() => new Response("error", { status: 500 }))
            const first = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 })

            const second = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", first.cache, {
                now: 1_000 + 30_000,
            })

            assert.equal(fetchMock.mock.calls.length, 1)
            assert.equal(second.value, null)
            assert.equal(second.failed, true)
        } finally {
            restore()
        }
    })

    it("失敗から待機時間を過ぎたら取り直し、成功すれば失敗の記録が消える", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const failed = { value: "last-good", fetchedAtMs: 1_000, failedAtMs: 2_000 }
            const fetchMock = stubFetch(() => Response.json({ value: "fresh" }))

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", failed, {
                now: 2_000 + 60_000,
            })

            assert.equal(fetchMock.mock.calls.length, 1)
            assert.deepEqual(result.cache, { value: "fresh", fetchedAtMs: 62_000 })
            assert.equal(result.failed, undefined)
        } finally {
            restore()
        }
    })

    it("同時に来た要求は1回の取得にまとめる", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            const fetchMock = stubFetch(() => Response.json({ value: "shared" }))

            const results = await Promise.all([
                resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 }),
                resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 }),
                resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 }),
            ])

            assert.equal(fetchMock.mock.calls.length, 1)
            assert.deepEqual(
                results.map((r) => r.value),
                ["shared", "shared", "shared"]
            )
        } finally {
            restore()
        }
    })

    it("形の違う応答は失敗として扱う", async () => {
        const restore = setEnv("https://issuedeck.example", "api-secret")
        try {
            stubFetch(() => Response.json({ notValue: "wrong-shape" }))
            const cache = { value: "last-good", fetchedAtMs: 1_000 }

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", cache, {
                now: 1_000 + 10 * 60 * 1000 + 1,
            })

            assert.equal(result.value, "last-good")
        } finally {
            restore()
        }
    })

    it("ISSUE_DECK_URL・SHARED_TOKEN_API_SECRETのどちらかが無ければ、取得を試みず直前の値を返す", async () => {
        const restore = setEnv(undefined, "api-secret")
        try {
            const fetchMock = stubFetch(() => Response.json({ value: "unused" }))
            const cache = { value: "last-good", fetchedAtMs: 1_000 }

            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", cache, {
                now: 1_000 + 10 * 60 * 1000 + 1,
            })

            assert.equal(result.value, "last-good")
            assert.equal(fetchMock.mock.calls.length, 0)
        } finally {
            restore()
        }
    })

    it("未設定でキャッシュも無ければnullを返す", async () => {
        const restore = setEnv(undefined, undefined)
        try {
            const result = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", null, { now: 1_000 })
            assert.equal(result.value, null)
            assert.equal(result.cache, null)
        } finally {
            restore()
        }
    })
})
