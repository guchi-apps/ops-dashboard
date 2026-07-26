import fs from "fs"
import os from "os"
import type { SystemStats } from "@/types/system-stats"

interface CpuSample {
    idle: number
    total: number
}

function readCpuSample(): CpuSample | null {
    try {
        const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0]
        if (!line?.startsWith("cpu ")) return null

        const values = line
            .split(/\s+/)
            .slice(1)
            .map((value) => Number.parseInt(value, 10))
        if (values.some((value) => Number.isNaN(value))) return null

        const idle = values[3] + values[4]
        const total = values.reduce((sum, value) => sum + value, 0)
        return { idle, total }
    } catch {
        return null
    }
}

async function getCpuPercent(): Promise<number> {
    const first = readCpuSample()
    if (!first) return 0

    await new Promise<void>((resolve) => {
        setTimeout(resolve, 100)
    })

    const second = readCpuSample()
    if (!second) return 0

    const idleDelta = second.idle - first.idle
    const totalDelta = second.total - first.total
    if (totalDelta <= 0) return 0

    return Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10
}

function getMemoryStats() {
    try {
        const meminfo = fs.readFileSync("/proc/meminfo", "utf8")
        const readValue = (key: string) => {
            const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))
            return match ? Number.parseInt(match[1], 10) * 1024 : 0
        }

        const totalBytes = readValue("MemTotal")
        const availableBytes = readValue("MemAvailable")
        const usedBytes = Math.max(totalBytes - availableBytes, 0)
        const usedPercent =
            totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0

        return { usedBytes, totalBytes, usedPercent }
    } catch {
        const totalBytes = os.totalmem()
        const usedBytes = totalBytes - os.freemem()
        const usedPercent =
            totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
        return { usedBytes, totalBytes, usedPercent }
    }
}

function getDiskStats(): SystemStats["disk"] {
    const path = process.env.SYSTEM_STATS_DISK_PATH || "/"

    try {
        const stats = fs.statfsSync(path)
        const totalBytes = stats.blocks * stats.bsize
        const freeBytes = stats.bfree * stats.bsize
        const usedBytes = Math.max(totalBytes - freeBytes, 0)
        const usedPercent =
            totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0

        return { usedBytes, totalBytes, usedPercent, path }
    } catch {
        return { usedBytes: 0, totalBytes: 0, usedPercent: 0, path }
    }
}

function getMockStats(): SystemStats {
    return {
        cpuPercent: 18.4,
        memory: {
            usedBytes: 1.2 * 1024 ** 3,
            totalBytes: 4 * 1024 ** 3,
            usedPercent: 30,
        },
        disk: {
            usedBytes: 24 * 1024 ** 3,
            totalBytes: 80 * 1024 ** 3,
            usedPercent: 30,
            path: "/",
        },
        loadAverage: [0.42, 0.38, 0.35],
        uptimeSeconds: 86400 * 12,
        hostname: os.hostname(),
        platform: os.platform(),
        isMock: true,
    }
}

export async function getSystemStats(): Promise<SystemStats> {
    const cpuSample = readCpuSample()
    const disk = getDiskStats()

    if (!cpuSample || disk.totalBytes === 0) {
        return getMockStats()
    }

    const [cpuPercent, memory, loadAverage, uptimeSeconds] = await Promise.all([
        getCpuPercent(),
        Promise.resolve(getMemoryStats()),
        Promise.resolve(os.loadavg() as [number, number, number]),
        Promise.resolve(os.uptime()),
    ])

    return {
        cpuPercent,
        memory,
        disk,
        loadAverage,
        uptimeSeconds,
        hostname: os.hostname(),
        platform: os.platform(),
        isMock: false,
    }
}
