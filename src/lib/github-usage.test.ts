import assert from "node:assert/strict"
import { test } from "node:test"
import { getGitHubUsageSnapshot } from "@/lib/github-usage"
import { redirectStateFile } from "@/lib/ai-usage/test-support"

test("課金レポートだけ30秒待ち、ほかのGitHub APIは共通の10秒で打ち切る", async (t) => {
    redirectStateFile(t, "GH_USAGE_VISIBILITY_PATH")

    const previousToken = process.env.GH_USAGE_TOKEN
    const previousOrg = process.env.GH_USAGE_ORG
    process.env.GH_USAGE_TOKEN = "test-token"
    process.env.GH_USAGE_ORG = "test-org"
    t.after(() => {
        if (previousToken === undefined) delete process.env.GH_USAGE_TOKEN
        else process.env.GH_USAGE_TOKEN = previousToken
        if (previousOrg === undefined) delete process.env.GH_USAGE_ORG
        else process.env.GH_USAGE_ORG = previousOrg
    })

    const timeoutBySignal = new WeakMap<AbortSignal, number>()
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        const signal = new AbortController().signal
        timeoutBySignal.set(signal, milliseconds)
        return signal
    })

    const timeoutByPath = new Map<string, number>()
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        timeoutByPath.set(url.pathname, timeoutBySignal.get(init?.signal as AbortSignal) ?? 0)

        if (url.pathname.endsWith("/settings/billing/usage")) {
            return Promise.resolve(Response.json({ usageItems: [] }))
        }
        if (url.pathname.endsWith("/repos")) return Promise.resolve(Response.json([]))
        if (url.pathname === "/orgs/test-org") {
            return Promise.resolve(Response.json({ plan: { name: "free" } }))
        }
        if (url.pathname === "/rate_limit") {
            return Promise.resolve(
                Response.json({ resources: { core: { limit: 5_000, remaining: 4_999 } } })
            )
        }
        return Promise.resolve(new Response(null, { status: 404 }))
    })

    const snapshot = await getGitHubUsageSnapshot({ force: true })

    assert.equal(snapshot.status, "ok")
    assert.equal(timeoutByPath.get("/organizations/test-org/settings/billing/usage"), 30_000)
    assert.equal(timeoutByPath.get("/orgs/test-org/repos"), 10_000)
    assert.equal(timeoutByPath.get("/orgs/test-org"), 10_000)
    assert.equal(timeoutByPath.get("/rate_limit"), 10_000)
})
