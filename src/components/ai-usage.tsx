"use client"

import { useEffect, useState } from "react"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { cn } from "@/lib/utils"
import type { AiProviderUsage, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/** サーバー側のキャッシュ（既定5分）に合わせた取得間隔 */
const REFRESH_INTERVAL_MS = 300_000

/** リセットまでの残り時間表示を進めるための再描画間隔 */
const TICK_INTERVAL_MS = 30_000

function getUsageBarColor(percent: number): string {
    if (percent >= 90) return "bg-red-400"
    if (percent >= 75) return "bg-amber-400"
    return "bg-emerald-400"
}

function formatRemaining(resetsAt: string, now: number): string | null {
    const remainingMs = new Date(resetsAt).getTime() - now
    if (Number.isNaN(remainingMs)) return null
    if (remainingMs <= 0) return "まもなくリセット"

    const minutes = Math.floor(remainingMs / 60_000)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days >= 1) return `あと${days}日${hours % 24}時間でリセット`
    if (hours >= 1) return `あと${hours}時間${minutes % 60}分でリセット`
    return `あと${minutes}分でリセット`
}

function UsageWindowRow({ window: usageWindow, now }: { window: AiUsageWindow; now: number }) {
    const remaining = usageWindow.resetsAt ? formatRemaining(usageWindow.resetsAt, now) : null

    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium">
                    {usageWindow.label}
                    {usageWindow.note && (
                        <span className="ml-1 text-[10px] sm:text-xs opacity-70">{usageWindow.note}</span>
                    )}
                </span>
                <span className="font-mono text-sm sm:text-base font-bold">
                    残り {Math.round(100 - usageWindow.usedPercent)}%
                </span>
            </div>

            <div
                className="h-2 w-full overflow-hidden rounded-full bg-primary-foreground/20 dark:bg-muted"
                role="progressbar"
                aria-label={`${usageWindow.label}の使用率`}
                aria-valuenow={Math.round(usageWindow.usedPercent)}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div
                    className={cn("h-full rounded-full transition-all", getUsageBarColor(usageWindow.usedPercent))}
                    style={{ width: `${usageWindow.usedPercent}%` }}
                />
            </div>

            <div className="flex items-center justify-between gap-2 text-[10px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                <span>使用 {usageWindow.usedPercent}%</span>
                {remaining && <span>{remaining}</span>}
            </div>
        </div>
    )
}

function PlanBadge({ plan }: { plan: string | null }) {
    if (!plan) return null

    return (
        <span className="shrink-0 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-[10px] sm:text-xs font-semibold dark:bg-muted">
            {plan}
        </span>
    )
}

function ProviderCard({ provider, now }: { provider: AiProviderUsage; now: number }) {
    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm sm:text-base font-bold">{provider.name}</span>
                <PlanBadge plan={provider.plan} />
            </div>

            {provider.windows.length > 0 ? (
                <div className="space-y-3">
                    {provider.windows.map((usageWindow, index) => (
                        <UsageWindowRow
                            key={`${usageWindow.label}-${usageWindow.note ?? ""}-${index}`}
                            window={usageWindow}
                            now={now}
                        />
                    ))}
                </div>
            ) : (
                <p className="text-[11px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                    {provider.message ?? "使用状況を取得できませんでした"}
                </p>
            )}

            {provider.billing && (
                <div className="mt-auto flex items-baseline justify-between gap-2 border-t border-primary-foreground/20 pt-2 text-[10px] sm:text-xs text-primary-foreground/70 dark:border-border dark:text-muted-foreground">
                    <span>{provider.billing.label}</span>
                    <span className="font-mono">
                        {provider.billing.amount}
                        {provider.billing.limit && ` / ${provider.billing.limit}`}
                    </span>
                </div>
            )}
        </DashboardCard>
    )
}

export function AiUsage() {
    const [snapshot, setSnapshot] = useState<AiUsageSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            try {
                const res = await fetch("/api/ai-usage", { cache: "no-store" })
                if (!res.ok) throw new Error("Failed to fetch AI usage")

                const data = (await res.json()) as AiUsageSnapshot
                if (!cancelled) setSnapshot(data)
            } catch (error) {
                console.error("Failed to fetch AI usage:", error)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }

        void load()
        const intervalId = setInterval(() => void load(), REFRESH_INTERVAL_MS)

        return () => {
            cancelled = true
            clearInterval(intervalId)
        }
    }, [])

    useEffect(() => {
        const tickId = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS)
        return () => clearInterval(tickId)
    }, [])

    if (loading || !snapshot) return null

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="AI Usage"
                trailing={
                    <span className="text-xs font-mono text-muted-foreground truncate">
                        {new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", {
                            hour: "2-digit",
                            minute: "2-digit",
                        })}{" "}
                        時点
                    </span>
                }
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {snapshot.providers.map((provider) => (
                    <ProviderCard key={provider.id} provider={provider} now={now} />
                ))}
            </div>
        </section>
    )
}
