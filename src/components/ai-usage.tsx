"use client"

import { useDashboardData } from "@/components/dashboard-data"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent } from "@/lib/usage-format"
import type { AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

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
    const { aiUsage: snapshot, now } = useDashboardData()

    if (!snapshot) return null

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
