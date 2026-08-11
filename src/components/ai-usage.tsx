"use client"

import { useEffect, useState } from "react"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent } from "@/lib/usage-format"
import type { AiProviderUsage, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/** サーバー側のキャッシュ（既定5分）に合わせた取得間隔 */
const REFRESH_INTERVAL_MS = 300_000

/** リセットまでの残り時間表示を進めるための再描画間隔 */
const TICK_INTERVAL_MS = 30_000

/** 制限枠の長さとリセット時刻から、枠のうち何割の時間が過ぎたかを出す */
function getWindowElapsedPercent(usageWindow: AiUsageWindow, now: number): number | null {
    if (!usageWindow.resetsAt || !usageWindow.windowSeconds) return null

    const resetsAtMs = new Date(usageWindow.resetsAt).getTime()
    if (Number.isNaN(resetsAtMs)) return null

    return getElapsedPercent(resetsAtMs - usageWindow.windowSeconds * 1000, resetsAtMs, now)
}

function UsageWindowRow({ window: usageWindow, now }: { window: AiUsageWindow; now: number }) {
    return (
        <UsageBar
            label={usageWindow.label}
            note={usageWindow.note}
            usedPercent={usageWindow.usedPercent}
            elapsedPercent={getWindowElapsedPercent(usageWindow, now)}
            remainingText={usageWindow.resetsAt ? formatRemaining(usageWindow.resetsAt, now) : null}
        />
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
