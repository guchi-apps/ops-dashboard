"use client"

import { useEffect, useState } from "react"
import { MetricCard, getUsageColor } from "@/components/metric-card"
import { SectionHeading } from "@/components/section-heading"
import { Sparkline } from "@/components/sparkline"
import { formatBytes, formatUptime } from "@/lib/system-stats-format"
import { cn } from "@/lib/utils"
import type { HostStatsHistoryPoint, HostStatsService, HostStatsView } from "@/types/host-stats"

/** VPS Status と同じ取得間隔。エージェントの送信間隔（既定1分）より短くても害はない */
const REFRESH_INTERVAL_MS = 30_000

/** 温度グラフの縦軸の最小の幅（℃）。変動が小さいときに波形が暴れて見えないようにする */
const MIN_TEMPERATURE_SPAN = 10

/** CPU温度の色分け。使用率（%）とは基準が違うため別に持つ */
function getTemperatureColor(celsius: number): string {
    if (celsius >= 85) return "text-red-400"
    if (celsius >= 70) return "text-amber-400"
    return "text-emerald-400"
}

function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}秒前`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`
    return `${Math.floor(seconds / 86400)}日前`
}

function pick(
    history: HostStatsHistoryPoint[],
    key: keyof HostStatsHistoryPoint
): number[] {
    return history
        .map((point) => point[key])
        .filter((value): value is number => typeof value === "number")
}

function OfflineBanner({ ageSeconds, offlineAfterSeconds }: { ageSeconds: number; offlineAfterSeconds: number }) {
    return (
        <div
            className="rounded-lg border border-dashed border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-950 dark:text-red-100"
            role="status"
        >
            <p className="font-semibold">オフラインの可能性があります</p>
            <p className="mt-1 text-red-900/80 dark:text-red-200/80">
                最終受信が{formatAge(ageSeconds)}で、しきい値（{Math.round(offlineAfterSeconds / 60)}分）を超えています。
                表示しているのはその時点の値です。
            </p>
        </div>
    )
}

function ServiceBadges({ services }: { services: HostStatsService[] }) {
    return (
        <div className="flex flex-wrap gap-2">
            {services.map((service) => (
                <span
                    key={service.name}
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-mono",
                        service.active
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                    )}
                >
                    <span
                        className={cn(
                            "size-1.5 rounded-full",
                            service.active ? "bg-emerald-500" : "bg-red-500"
                        )}
                        aria-hidden
                    />
                    {service.name}
                    <span className="opacity-70">{service.state}</span>
                </span>
            ))}
        </div>
    )
}

export function HostStats() {
    const [view, setView] = useState<HostStatsView | null>(null)

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            try {
                const res = await fetch("/api/host-stats", { cache: "no-store" })
                if (!res.ok) throw new Error("Failed to fetch host stats")

                const data = (await res.json()) as HostStatsView
                if (!cancelled) setView(data)
            } catch (error) {
                console.error("Failed to fetch host stats:", error)
            }
        }

        void load()
        const intervalId = setInterval(() => void load(), REFRESH_INTERVAL_MS)

        return () => {
            cancelled = true
            clearInterval(intervalId)
        }
    }, [])

    // 一度も受信していない（エージェント未設置）ならセクションごと出さない
    if (!view?.latest) return null

    const { latest, history, online } = view

    // 保存済みファイルが古い形式・壊れている場合に、画面全体を巻き込んで落とさないための保険
    if (!latest.disks?.length || !latest.loadAverage) return null

    const services = latest.services ?? []
    const dimmed = !online

    // 履歴に残しているのは最も使用率が高いディスク1件。カードもそれに合わせる
    const worstDisk = latest.disks.reduce((worst, disk) =>
        disk.usedPercent > worst.usedPercent ? disk : worst
    )
    const otherDisks = latest.disks.filter((disk) => disk.path !== worstDisk.path)

    const loads = pick(history, "load")
    const temperatures = pick(history, "temp")
    const temperatureMin = temperatures.length > 0 ? Math.min(...temperatures) : 0
    const temperatureMax = temperatures.length > 0 ? Math.max(...temperatures) : 0
    const temperatureSpan = Math.max(MIN_TEMPERATURE_SPAN, temperatureMax - temperatureMin)

    const chartClass = "h-6 w-full"
    const historyLabelSuffix = `直近${view.historyHours}時間の推移`

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title={`${view.label} Status`}
                trailing={
                    <>
                        {!online && (
                            <span className="text-xs font-mono font-semibold px-2 py-1 rounded-md bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/30">
                                OFFLINE
                            </span>
                        )}
                        <span className="text-xs font-mono text-muted-foreground truncate">
                            {latest.hostname}
                        </span>
                    </>
                }
            />

            {!online && view.ageSeconds !== null && (
                <OfflineBanner ageSeconds={view.ageSeconds} offlineAfterSeconds={view.offlineAfterSeconds} />
            )}

            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
                <MetricCard
                    label="CPU"
                    value={`${latest.cpuPercent}%`}
                    valueClassName={getUsageColor(latest.cpuPercent)}
                    dimmed={dimmed}
                    chart={
                        <Sparkline
                            values={pick(history, "cpu")}
                            className={cn(chartClass, getUsageColor(latest.cpuPercent))}
                            label={`CPU使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                <MetricCard
                    label="Memory"
                    value={`${latest.memory.usedPercent}%`}
                    detail={`${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`}
                    valueClassName={getUsageColor(latest.memory.usedPercent)}
                    dimmed={dimmed}
                    chart={
                        <Sparkline
                            values={pick(history, "mem")}
                            className={cn(chartClass, getUsageColor(latest.memory.usedPercent))}
                            label={`メモリ使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                {latest.swap && latest.swap.totalBytes > 0 && (
                    <MetricCard
                        label="Swap"
                        value={`${latest.swap.usedPercent}%`}
                        detail={`${formatBytes(latest.swap.usedBytes)} / ${formatBytes(latest.swap.totalBytes)}`}
                        valueClassName={getUsageColor(latest.swap.usedPercent)}
                        dimmed={dimmed}
                        chart={
                            <Sparkline
                                values={pick(history, "swap")}
                                className={cn(chartClass, getUsageColor(latest.swap.usedPercent))}
                                label={`Swap使用率の${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
                <MetricCard
                    label="Disk"
                    value={`${worstDisk.usedPercent}%`}
                    detail={`${formatBytes(worstDisk.usedBytes)} / ${formatBytes(worstDisk.totalBytes)}（${worstDisk.path}）`}
                    valueClassName={getUsageColor(worstDisk.usedPercent)}
                    dimmed={dimmed}
                    chart={
                        <Sparkline
                            values={pick(history, "disk")}
                            className={cn(chartClass, getUsageColor(worstDisk.usedPercent))}
                            label={`ディスク使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                <MetricCard
                    label="Load Avg"
                    value={latest.loadAverage[0].toFixed(2)}
                    detail={`1m / 5m / 15m: ${latest.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`}
                    dimmed={dimmed}
                    chart={
                        <Sparkline
                            values={loads}
                            max={Math.max(...loads, 1)}
                            className={cn(chartClass, "text-sky-400")}
                            label={`Load Averageの${historyLabelSuffix}`}
                        />
                    }
                />
                <MetricCard
                    label="Uptime"
                    value={formatUptime(latest.uptimeSeconds)}
                    detail={latest.os ?? latest.kernel}
                    dimmed={dimmed}
                />
                {latest.temperatureCelsius !== undefined && (
                    <MetricCard
                        label="Temp"
                        value={`${latest.temperatureCelsius}°C`}
                        valueClassName={getTemperatureColor(latest.temperatureCelsius)}
                        dimmed={dimmed}
                        chart={
                            <Sparkline
                                values={temperatures}
                                min={temperatureMin}
                                max={temperatureMin + temperatureSpan}
                                className={cn(chartClass, getTemperatureColor(latest.temperatureCelsius))}
                                label={`CPU温度の${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
            </div>

            {services.length > 0 && <ServiceBadges services={services} />}

            <p className="text-xs text-muted-foreground">
                最終受信: {view.ageSeconds !== null ? formatAge(view.ageSeconds) : "—"}
                {otherDisks.length > 0 && (
                    <>
                        {" / その他のディスク: "}
                        {otherDisks
                            .map((disk) => `${disk.path} ${disk.usedPercent}%`)
                            .join(" · ")}
                    </>
                )}
            </p>
        </section>
    )
}
