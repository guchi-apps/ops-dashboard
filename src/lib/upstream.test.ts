import assert from "node:assert/strict"
import { test } from "node:test"
import { isPermissionStatus, looksLikePermissionError } from "@/lib/upstream"

test("401と403だけを権限不足として扱う", () => {
    assert.equal(isPermissionStatus(401), true)
    assert.equal(isPermissionStatus(403), true)
    for (const status of [200, 404, 429, 500, 503]) assert.equal(isPermissionStatus(status), false)
})

test("CLIの失敗文面から権限不足を見分ける", () => {
    assert.equal(looksLikePermissionError("[ERROR] 401 Unauthorized"), true)
    assert.equal(looksLikePermissionError("Forbidden: service account token is not authorized"), true)
    assert.equal(looksLikePermissionError("Command failed: spawn op ENOENT"), false)
    assert.equal(looksLikePermissionError("timed out after 10000ms"), false)
})
