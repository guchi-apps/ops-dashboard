import assert from "node:assert/strict"
import { test } from "node:test"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import {
    applyMonitorDisplayNames,
    clearMonitorDisplayName,
    setMonitorDisplayName,
} from "@/lib/monitor-names"
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/monitor-source"

interface Fake {
    id: number
    name: string
    originalName?: string
}

const apply = (source: "kuma" | "robot", monitors: Fake[]) =>
    applyMonitorDisplayNames(
        source,
        monitors,
        (m) => m.name,
        (m, name, originalName) => ({ ...m, name, originalName })
    )

test("上書きした名前が適用され、元の名前が残る", async (t) => {
    redirectStateFile(t, "MONITOR_NAMES_PATH")
    await setMonitorDisplayName("kuma", 1, "  愛車メンテ ")

    const [a, b] = await apply("kuma", [
        { id: 1, name: "car-care" },
        { id: 2, name: "other" },
    ])
    assert.deepEqual(a, { id: 1, name: "愛車メンテ", originalName: "car-care" })
    assert.deepEqual(b, { id: 2, name: "other" })
})

test("系統が違えば同じIDでも適用されない", async (t) => {
    redirectStateFile(t, "MONITOR_NAMES_PATH")
    await setMonitorDisplayName("kuma", 1, "X")

    const [m] = await apply("robot", [{ id: 1, name: "robot-1" }])
    assert.equal(m.name, "robot-1")
})

test("空文字・元に戻す操作で上書きが消える", async (t) => {
    redirectStateFile(t, "MONITOR_NAMES_PATH")
    await setMonitorDisplayName("robot", 5, "名前")
    assert.equal(await setMonitorDisplayName("robot", 5, "   "), "cleared")
    assert.equal((await apply("robot", [{ id: 5, name: "orig" }]))[0].name, "orig")

    await setMonitorDisplayName("robot", 5, "名前")
    await clearMonitorDisplayName("robot", 5)
    assert.equal((await apply("robot", [{ id: 5, name: "orig" }]))[0].name, "orig")
})

test("長すぎる名前は保存しない", async (t) => {
    redirectStateFile(t, "MONITOR_NAMES_PATH")
    assert.equal(await setMonitorDisplayName("kuma", 1, "あ".repeat(MAX_DISPLAY_NAME_LENGTH + 1)), null)
})
