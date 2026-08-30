"use client"

import { useDashboardData } from "@/components/dashboard-data"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent } from "@/lib/usage-format"
import type { AiProviderCredit, AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

/** サブスク枠と区別が付くよう、クレジット枠の行にはこの補足を添える */
const CREDIT_LABEL = "クレジット枠"
const CREDIT_NOTE = "サブスク外"

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

/**
 * サブスクとは別会計のクレジット枠。上限が分かるときは他の枠と同じバーで出し、
 * 分かるのが残高だけのとき（ChatGPT）は割合を推測せず数値だけを出す。
 */
function CreditRow({ credit, now }: { credit: AiProviderCredit; now: number }) {
    if (credit.usedPercent !== null) {
        return (
            <UsageBar
                label={CREDIT_LABEL}
                note={CREDIT_NOTE}
                usedPercent={credit.usedPercent}
                valueText={credit.valueText}
                usedText={credit.detailText ?? undefined}
                remainingText={credit.resetsAt ? formatRemaining(credit.resetsAt, now) : null}
            />
        )
    }

    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium">
                    {CREDIT_LABEL}
                    <span className="ml-1 text-[10px] sm:text-xs opacity-70">{CREDIT_NOTE}</span>
                </span>
                <span className="font-mono text-sm sm:text-base font-bold">{credit.valueText}</span>
            </div>
            {credit.detailText && (
                <p className="text-[10px] sm:text-xs text-muted-foreground">{credit.detailText}</p>
            )}
        </div>
    )
}

function PlanBadge({ plan }: { plan: string | null }) {
    if (!plan) return null

    return (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] sm:text-xs font-semibold">
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
                <p className="text-[11px] sm:text-xs text-muted-foreground">
                    {provider.message ?? "使用状況を取得できませんでした"}
                </p>
            )}

            {provider.credit && (
                <div className="mt-auto border-t border-border pt-2.5">
                    <CreditRow credit={provider.credit} now={now} />
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
