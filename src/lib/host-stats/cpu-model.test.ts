import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { describeCpu } from "@/lib/host-stats/format"
import { HostStatsReportError, parseHostStatsReport } from "@/lib/host-stats/report"

const BASE = {
    version: 1,
    hostname: "subpc",
    cpuPercent: 12.4,
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 50 },
    disks: [{ path: "/", usedBytes: 1, totalBytes: 2, usedPercent: 50 }],
    loadAverage: [0.1, 0.2, 0.3],
    uptimeSeconds: 100,
    services: [],
}

describe("CPU機種名", () => {
    it("機種名とスレッド数を1行にまとめる", () => {
        assert.equal(describeCpu("AMD  Athlon 200GE", 4), "AMD Athlon 200GE · 4スレッド")
    })

    it("内蔵GPU名・商標記号・定格クロックを削る", () => {
        assert.equal(describeCpu("AMD Ryzen 5 PRO 4650G with Radeon Graphics", 12), "AMD Ryzen 5 PRO 4650G · 12スレッド")
        assert.equal(describeCpu("Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz", 12), "Intel Core i7-8700 · 12スレッド")
    })

    it("片方だけでも出し、どちらも無ければ undefined", () => {
        assert.equal(describeCpu("Apple M4", undefined), "Apple M4")
        assert.equal(describeCpu(undefined, 10), "10スレッド")
        assert.equal(describeCpu(undefined, undefined), undefined)
    })

    it("送られた項目を受け取り、送らない世代でも受信できる", () => {
        const withCpu = parseHostStatsReport({ ...BASE, cpuModel: "Apple M4", cpuThreads: 10 })
        assert.equal(withCpu.cpuModel, "Apple M4")
        assert.equal(withCpu.cpuThreads, 10)

        const legacy = parseHostStatsReport(BASE)
        assert.equal(legacy.cpuModel, undefined)
        assert.equal(legacy.cpuThreads, undefined)
    })

    it("型の違う値は弾く", () => {
        assert.throws(() => parseHostStatsReport({ ...BASE, cpuModel: 5 }), HostStatsReportError)
        assert.throws(() => parseHostStatsReport({ ...BASE, cpuThreads: "4" }), HostStatsReportError)
    })
})
