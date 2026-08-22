"use client"

import { NEUTRAL_METRIC_COLORS, getTemperatureColor, getUsageColor } from "@/components/metric-card"
import { Sparkline } from "@/components/sparkline"
import { StatusBadge, StatusDot, type StatusTone } from "@/components/status-badge"
import { formatAge, formatBytes, formatRateShort, formatUptime } from "@/lib/host-stats/format"
import { pickSeries, sumSeries } from "@/lib/host-stats/history"
import { describeTimer, evaluateTimers, type TimerState, type TimerStatus } from "@/lib/host-stats/timers"
import { cn } from "@/lib/utils"
import type { HostStatsHostView } from "@/types/host-stats"

/** 温度グラフの縦軸の最小の幅（℃）。変動が小さいときに波形が暴れて見えないようにする */
const MIN_TEMPERATURE_SPAN = 10

function formatRate(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`
}

function MiniMetric({
    label,
    value,
    detail,
    valueClassName,
    values,
    min,
    max,
    chartLabel,
}: {
    label: string
    value: string
    detail?: string
    valueClassName?: string
    values?: number[]
    min?: number
    max?: number
    chartLabel: string
}) {
    return (
        <div className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div className={cn("font-mono text-lg font-bold leading-tight sm:text-xl", valueClassName)}>
                {value}
            </div>
            {values && (
                // 狭い画面では補足を出さない代わりに、波形を高くして読み取りやすくする（#96）
                <Sparkline
                    values={values}
                    min={min}
                    max={max}
                    className={cn("mt-0.5 h-6 w-full sm:h-4", valueClassName)}
                    label={chartLabel}
                />
            )}
            {detail && (
                <div className="hidden truncate text-[9px] text-muted-foreground sm:block" title={detail}>
                    {detail}
                </div>
            )}
        </div>
    )
}

/**
 * 副次的な指標。主要4指標の下に1行で流す。
 * 狭い画面では出さない（#96）。概要は推移を眺める場所で、数字を読むのはホストタブの役目。
 */
function SecondaryFacts({ facts }: { facts: { label: string; value: string }[] }) {
    if (facts.length === 0) return null

    return (
        <div className="mt-2 hidden flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground sm:flex">
            {facts.map((fact) => (
                <span key={fact.label}>
                    {fact.label} <span className="font-mono text-foreground">{fact.value}</span>
                </span>
            ))}
        </div>
    )
}

/** 定期ジョブの状態と色の対応。unknown は「壊れている」ではないので警告どまりにする */
const TIMER_TONES: Record<TimerState, StatusTone> = {
    ok: "ok",
    running: "info",
    failed: "danger",
    overdue: "danger",
    stopped: "danger",
    missing: "danger",
    unknown: "warn",
}

/**
 * 定期ジョブ（systemd timer）の一覧。
 *
 * サービスのバッジと違い、oneshot のジョブは「いま動いているか」ではなく
 * 「前回いつ動いて、どう終わったか」が知りたい情報なので、1行1ユニットで並べる。
 * 異常なものは狭い画面でも隠さない（見に行かないと分からない異常を減らすのが目的のため）。
 */
function TimerList({ statuses }: { statuses: TimerStatus[] }) {
    if (statuses.length === 0) return null

    const hasAbnormal = statuses.some((status) => status.abnormal)

    return (
        <div className={cn("mt-2 gap-1", hasAbnormal ? "flex flex-col" : "hidden sm:flex sm:flex-col")}>
            <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">定期ジョブ</div>
            {statuses.map((status) => {
                const detail = describeTimer(status)

                return (
                    <div
                        key={status.timer.name}
                        className={cn(
                            "flex min-w-0 items-center gap-1.5 text-[10px]",
                            !status.abnormal && "hidden sm:flex"
                        )}
                    >
                        <StatusDot tone={TIMER_TONES[status.state]} />
                        <span className="shrink-0 font-mono">{status.timer.name}</span>
                        <span className="truncate text-muted-foreground" title={detail}>
                            {detail}
                        </span>
                    </div>
                )
            })}
        </div>
    )
}

/**
 * 概要タブに出す、1ホスト＝1枚のカード。
 *
 * 詳細タブと同じ内容を全部出すと1画面に収まらないため、主要4指標＋副次指標の1行に畳んでいる。
 * 個々の推移をじっくり見るのはホストタブの役目。
 *
 * 狭い画面（スマホ）ではさらに絞り、指標と推移グラフだけにする（#96）。1台で1画面を使い切ると、
 * 2台目やtmuxの一覧までスクロールしないと状況をつかめない。
 */
export function HostCard({
    host,
    historyHours,
}: {
    host: HostStatsHostView
    historyHours: number
}) {
    const { latest, history, online } = host

    // 保存済みファイルが古い形式・壊れている場合に、画面全体を巻き込んで落とさないための保険
    if (!latest.disks?.length || !latest.loadAverage) return null

    const suffix = `直近${historyHours}時間の推移`
    const worstDisk = latest.disks.reduce((worst, disk) =>
        disk.usedPercent > worst.usedPercent ? disk : worst
    )

    const temperatures = pickSeries(history, "temp")
    const temperatureMin = temperatures.length > 0 ? Math.min(...temperatures) : 0
    const temperatureMax = temperatures.length > 0 ? Math.max(...temperatures) : 0
    const temperatureSpan = Math.max(MIN_TEMPERATURE_SPAN, temperatureMax - temperatureMin)

    const loads = pickSeries(history, "load")
    const networkSeries = sumSeries(pickSeries(history, "rx"), pickSeries(history, "tx"))

    const facts = [
        { label: "LOAD", value: latest.loadAverage.map((value) => value.toFixed(2)).join(" / ") },
        latest.swap && latest.swap.totalBytes > 0
            ? { label: "SWAP", value: `${latest.swap.usedPercent}%` }
            : null,
        latest.network
            ? {
                  label: "NET",
                  value: `↓${formatRate(latest.network.inBytesPerSecond)} ↑${formatRate(latest.network.outBytesPerSecond)}`,
              }
            : null,
        latest.diskIo
            ? {
                  label: "I/O",
                  value: `R ${formatRate(latest.diskIo.inBytesPerSecond)} W ${formatRate(latest.diskIo.outBytesPerSecond)}`,
              }
            : null,
        latest.topProcesses && latest.topProcesses.length > 0
            ? {
                  label: "CPU上位",
                  value: latest.topProcesses
                      .slice(0, 2)
                      .map((process) => `${process.name} ${process.cpuPercent}%`)
                      .join(" · "),
              }
            : null,
        // メモリ枯渇はCPU上位の一覧に出てこないため、並べて置く
        latest.topMemoryProcesses && latest.topMemoryProcesses.length > 0
            ? {
                  label: "MEM上位",
                  value: latest.topMemoryProcesses
                      .slice(0, 2)
                      .map((process) =>
                          process.memoryBytes === undefined
                              ? process.name
                              : `${process.name} ${formatBytes(process.memoryBytes)}`
                      )
                      .join(" · "),
              }
            : null,
    ].filter((fact): fact is { label: string; value: string } => fact !== null)

    const { maintenance, sessions } = latest

    // 狭い画面の概要はグラフだけに畳むが、停止しているサービスだけは隠さない（#96）。
    // 更新・再起動待ちは画面上部の「メンテ」チップが拾うため、ここでは広い画面のみに出す
    const hasStoppedService = (latest.services ?? []).some((service) => !service.active)
    const timerStatuses = evaluateTimers(latest.timers)

    return (
        <div className={cn("h-full rounded-xl border border-border bg-card p-3", !online && "opacity-70")}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusDot tone={online ? "ok" : "danger"} />
                <span className="text-sm font-bold">{host.label}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {latest.hostname}
                </span>
                {!online && (
                    <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-red-600 dark:text-red-400">
                        OFFLINE
                    </span>
                )}
                <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                    稼働 {formatUptime(latest.uptimeSeconds)} · 受信 {formatAge(host.ageSeconds)}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniMetric
                    label="CPU"
                    value={`${latest.cpuPercent}%`}
                    valueClassName={getUsageColor(latest.cpuPercent)}
                    values={pickSeries(history, "cpu")}
                    chartLabel={`CPU使用率の${suffix}`}
                    detail={latest.os ?? latest.kernel}
                />
                <MiniMetric
                    label="Memory"
                    value={`${latest.memory.usedPercent}%`}
                    valueClassName={getUsageColor(latest.memory.usedPercent)}
                    values={pickSeries(history, "mem")}
                    chartLabel={`メモリ使用率の${suffix}`}
                    detail={`${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`}
                />
                <MiniMetric
                    label="Disk"
                    value={`${worstDisk.usedPercent}%`}
                    valueClassName={getUsageColor(worstDisk.usedPercent)}
                    values={pickSeries(history, "disk")}
                    chartLabel={`ディスク使用率の${suffix}`}
                    detail={`${formatBytes(worstDisk.usedBytes)} / ${formatBytes(worstDisk.totalBytes)}（${worstDisk.path}）`}
                />
                {latest.temperatureCelsius !== undefined ? (
                    <MiniMetric
                        label="Temp"
                        value={`${latest.temperatureCelsius}°C`}
                        valueClassName={getTemperatureColor(latest.temperatureCelsius)}
                        values={temperatures}
                        min={temperatureMin}
                        max={temperatureMin + temperatureSpan}
                        chartLabel={`CPU温度の${suffix}`}
                        detail="CPU温度"
                    />
                ) : latest.network ? (
                    <MiniMetric
                        label="Network"
                        value={`↓${formatRateShort(latest.network.inBytesPerSecond)}`}
                        valueClassName={NEUTRAL_METRIC_COLORS.network}
                        values={networkSeries}
                        max={Math.max(...networkSeries, 1)}
                        chartLabel={`ネットワーク転送量の${suffix}`}
                        detail={`↑ ${formatRate(latest.network.outBytesPerSecond)}`}

                    />
                ) : (
                    <MiniMetric
                        label="Load"
                        value={latest.loadAverage[0].toFixed(2)}
                        valueClassName={NEUTRAL_METRIC_COLORS.load}
                        values={loads}
                        max={Math.max(...loads, 1)}
                        chartLabel={`Load Averageの${suffix}`}
                        detail="1分平均"
                    />
                )}
            </div>

            <SecondaryFacts facts={facts} />

            <div className={cn("mt-2 flex-wrap gap-1.5", hasStoppedService ? "flex" : "hidden sm:flex")}>
                {(latest.services ?? []).map((service) => (
                    <StatusBadge
                        key={service.name}
                        tone={service.active ? "ok" : "danger"}
                        withDot
                        className={cn(service.active && "hidden sm:inline-flex")}
                    >
                        {service.name}
                    </StatusBadge>
                ))}
                {maintenance?.rebootRequired && (
                    <StatusBadge tone="danger" className="hidden sm:inline-flex">
                        再起動待ち
                    </StatusBadge>
                )}
                {maintenance?.updatesAvailable !== undefined && maintenance.updatesAvailable > 0 && (
                    <StatusBadge
                        tone={maintenance.securityUpdatesAvailable ? "danger" : "warn"}
                        className="hidden sm:inline-flex"
                    >
                        更新 {maintenance.updatesAvailable}件
                        {maintenance.securityUpdatesAvailable
                            ? `（セキュリティ ${maintenance.securityUpdatesAvailable}件）`
                            : ""}
                    </StatusBadge>
                )}
                {sessions && sessions.count > 0 && (
                    <StatusBadge tone="neutral" className="hidden sm:inline-flex">
                        ログイン {sessions.count}
                        {sessions.users.length > 0 && `（${sessions.users.join(", ")}）`}
                    </StatusBadge>
                )}
            </div>

            <TimerList statuses={timerStatuses} />
        </div>
    )
}
