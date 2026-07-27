"use client"

import { useEffect, useState } from "react"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { formatBytes, formatUptime } from "@/lib/system-stats-format"
import type { SystemStats } from "@/types/system-stats"
import { cn } from "@/lib/utils"

const REFRESH_INTERVAL_MS = 30_000

function getUsageColor(percent: number): string {
    if (percent >= 90) return "text-red-400"
    if (percent >= 75) return "text-amber-400"
    return "text-emerald-400"
}

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

function MetricCard({
    label,
    value,
    detail,
    valueClassName,
    isMock,
}: {
    label: string
    value: string
    detail?: string
    valueClassName?: string
    isMock?: boolean
}) {
    return (
        <DashboardCard
            className={cn(
                "h-full flex flex-col justify-center items-center text-center px-4 py-5",
                isMock && "ring-1 ring-dashed ring-amber-500/40"
            )}
        >
            <span className="text-xs opacity-70 uppercase tracking-widest mb-2">{label}</span>
            <div className={cn("text-2xl font-bold font-mono", valueClassName)}>{value}</div>
            {detail && (
                <div className="text-sm font-medium text-primary-foreground/70 dark:text-muted-foreground mt-2">
                    {detail}
                </div>
            )}
        </DashboardCard>
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
        <section className="space-y-4">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
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
