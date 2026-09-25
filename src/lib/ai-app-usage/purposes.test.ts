import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { countStates, resolvePurposes, type AiPurpose } from "@/lib/ai-app-usage/purposes"
import type { AiAppUsageApp } from "@/types/ai-app-usage"

const purposes: AiPurpose[] = [
    { app: "a", label: "A", provider: "p", kind: "metered" },
    { app: "b", label: "B", provider: "p", kind: "metered" },
    { app: "c", label: "C", provider: "p", kind: "metered" },
    { app: "Claude Code", label: "Q", provider: "p", kind: "quota", quotaOf: "claude" },
]

describe("resolvePurposes", () => {
    it("連携先の有無と取得結果で状態を分ける（枠の用途は常に quota）", () => {
        const apps: AiAppUsageApp[] = [
            { app: "a", status: "ok", features: [] },
            { app: "b", status: "error", message: "HTTP 500", features: [] },
        ]
        const rows = resolvePurposes(apps, purposes)
        assert.deepEqual(
            rows.map((row) => row.state),
            ["measured", "failed", "unlinked", "quota"],
        )
        assert.deepEqual(countStates(rows), { measured: 1, failed: 1, unlinked: 1, quota: 1 })
    })

    it("連携先が空ならメーター対象はすべて未連携", () => {
        assert.deepEqual(countStates(resolvePurposes([], purposes)), { measured: 0, failed: 0, unlinked: 3, quota: 1 })
    })
})
