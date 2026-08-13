"use client"

import { useEffect, useState } from "react"
import { MetricCard, getUsageColor } from "@/components/metric-card"
import { SectionHeading } from "@/components/section-heading"
import { formatBytes, formatUptime } from "@/lib/system-stats-format"
import type { SystemStats } from "@/types/system-stats"

const REFRESH_INTERVAL_MS = 30_000

function MockDataBanner() {
    return (
        <div
            className="rounded-lg border border-dashed border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
            role="status"
        >
            <p className="font-semibold">モックデータを表示中</p>
            <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
                本番 VPS 以外の環境では実際のメトリクスを取得できないため、サンプル値を表示しています。
            </p>
        </div>
    )
}

export function ServerStats() {
    const [stats, setStats] = useState<SystemStats | null>(null)
    const [statsLoading, setStatsLoading] = useState(true)

    useEffect(() => {
        let cancelled = false

        const loadStats = async () => {
            try {
                const res = await fetch("/api/system-stats", { cache: "no-store" })
                if (!res.ok) throw new Error("Failed to fetch system stats")

                const data = (await res.json()) as SystemStats
                if (!cancelled) {
                    setStats(data)
                    setStatsLoading(false)
                }
            } catch (error) {
                console.error("Failed to fetch system stats:", error)
                if (!cancelled) setStatsLoading(false)
            }
        }

        void loadStats()
        const intervalId = setInterval(() => void loadStats(), REFRESH_INTERVAL_MS)

        return () => {
            cancelled = true
            clearInterval(intervalId)
        }
    }, [])

    if (statsLoading || !stats) return null

    const memoryDetail = `${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}`
    const diskDetail = `${formatBytes(stats.disk.usedBytes)} / ${formatBytes(stats.disk.totalBytes)}`
    const loadDetail = stats.loadAverage.map((value) => value.toFixed(2)).join(" / ")

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="VPS Status"
                trailing={
                    <>
                        {stats.isMock && (
                            <span className="text-xs font-mono font-semibold px-2 py-1 rounded-md bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                                MOCK
                            </span>
                        )}
                        <span className="text-xs font-mono text-muted-foreground truncate">
                            {stats.hostname}
                        </span>
                    </>
                }
            />

            {stats.isMock && <MockDataBanner />}

            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
                <MetricCard
                    label="CPU"
                    value={`${stats.cpuPercent}%`}
                    valueClassName={getUsageColor(stats.cpuPercent)}
                    isMock={stats.isMock}
                />
                <MetricCard
                    label="Memory"
                    value={`${stats.memory.usedPercent}%`}
                    detail={memoryDetail}
                    valueClassName={getUsageColor(stats.memory.usedPercent)}
                    isMock={stats.isMock}
                />
                <MetricCard
                    label="Disk"
                    value={`${stats.disk.usedPercent}%`}
                    detail={diskDetail}
                    valueClassName={getUsageColor(stats.disk.usedPercent)}
                    isMock={stats.isMock}
                />
                <MetricCard
                    label="Load Avg"
                    value={stats.loadAverage[0].toFixed(2)}
                    detail={`1m / 5m / 15m: ${loadDetail}`}
                    isMock={stats.isMock}
                />
                <MetricCard
                    label="Uptime"
                    value={formatUptime(stats.uptimeSeconds)}
                    detail={`${stats.platform} server`}
                    isMock={stats.isMock}
                />
                <MetricCard
                    label="Disk Path"
                    value={stats.disk.path}
                    detail="監視対象"
                    isMock={stats.isMock}
                />
            </div>
        </section>
    )
}
