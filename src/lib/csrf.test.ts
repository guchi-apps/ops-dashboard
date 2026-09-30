import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { CSRF_HEADERS } from "@/lib/csrf-headers"

describe("rejectCrossSiteRequest", () => {
    it("専用ヘッダが無ければ403", async () => {
        const rejected = rejectCrossSiteRequest(new Request("http://x/api", { method: "POST" }))
        assert.equal(rejected?.status, 403)
    })

    it("値が違っても403", () => {
        const request = new Request("http://x/api", { method: "POST", headers: { "x-requested-with": "x" } })
        assert.equal(rejectCrossSiteRequest(request)?.status, 403)
    })

    it("画面が付けるヘッダなら通す", () => {
        const request = new Request("http://x/api", { method: "POST", headers: CSRF_HEADERS })
        assert.equal(rejectCrossSiteRequest(request), null)
    })
})
