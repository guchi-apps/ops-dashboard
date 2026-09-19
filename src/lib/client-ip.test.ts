import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { clientIpFromForwardedFor } from "@/lib/client-ip"

describe("clientIpFromForwardedFor", () => {
    it("要素が1つならそれを返す（Apacheが X-Forwarded-For を消して付け直した場合）", () => {
        assert.equal(clientIpFromForwardedFor("203.0.113.7"), "203.0.113.7")
    })

    it("クライアントが名乗った先頭ではなく、プロキシが足した末尾を返す", () => {
        assert.equal(clientIpFromForwardedFor("198.51.100.1, 203.0.113.7"), "203.0.113.7")
        assert.equal(
            clientIpFromForwardedFor("198.51.100.1, 198.51.100.2,203.0.113.7"),
            "203.0.113.7",
        )
    })

    it("前後の空白を除く", () => {
        assert.equal(clientIpFromForwardedFor("  203.0.113.7  "), "203.0.113.7")
    })

    it("空・未指定・区切りだけなら null", () => {
        assert.equal(clientIpFromForwardedFor(null), null)
        assert.equal(clientIpFromForwardedFor(undefined), null)
        assert.equal(clientIpFromForwardedFor(""), null)
        assert.equal(clientIpFromForwardedFor("198.51.100.1, "), null)
    })
})
