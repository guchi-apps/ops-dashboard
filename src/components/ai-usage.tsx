"use client"

import { useDashboardData } from "@/components/dashboard-data"
import { AiUsageHistory } from "@/components/ai-usage-history"
import { ClaudeCreditLedger } from "@/components/claude-credit-ledger"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent, toDayMarkers } from "@/lib/usage-format"
import type { AiProviderCredit, AiProviderMeteredUsage, AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

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
            markers={toDayMarkers(usageWindow.dayMarks)}
        />
    )
}

/**
 * サブスクとは別会計のクレジット枠。上限が分かるときは他の枠と同じバーで出し、
 * 分かるのが残高だけのとき（ChatGPT）は割合を推測せず数値だけを出す。
 * サブスク枠と違い経過率は出さない。「経過◯%」は時間の進みでしかなく、
 * Issueで求められた「使用 $X / 上限 $Y」の金額内訳（detailText）のほうが実態を表す（#250）。
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
                reservedPercent={credit.reservedPercent}
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

function formatTokens(tokens: number): string {
    return new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(tokens)
}

function formatUsd(value: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value < 0.01 ? 4 : 2,
    }).format(value)
}

/** 上限を返さないTypeSafeのような提供元の、実測トークン数・概算金額・呼出回数 */
function MeteredUsage({ usage }: { usage: AiProviderMeteredUsage }) {
    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <p className="font-mono text-base sm:text-lg font-bold">{formatTokens(usage.last24h.inputTokens)}</p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground">入力トークン（24時間）</p>
                </div>
                <div>
                    <p className="font-mono text-base sm:text-lg font-bold">{formatUsd(usage.last24h.estimatedCostUsd)}</p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground">概算金額（24時間）</p>
                </div>
            </div>
            <p className="border-t border-border pt-2 text-[10px] sm:text-xs text-muted-foreground">
                {usage.last24h.calls.toLocaleString("ja-JP")} 回 · 直近7日 {formatTokens(usage.last7d.inputTokens)} トークン
                {" · "}
                {formatUsd(usage.last7d.estimatedCostUsd)}
            </p>
            {usage.features.length > 0 && (
                <ul className="space-y-1 border-t border-border pt-2 text-[10px] sm:text-xs text-muted-foreground">
                    {usage.features.map((feature) => (
                        <li key={feature.label} className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate">{feature.label}</span>
                            <span className="shrink-0 font-mono">
                                {formatTokens(feature.last24h.inputTokens)} · {formatUsd(feature.last24h.estimatedCostUsd)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function ProviderCard({ provider, now }: { provider: AiProviderUsage; now: number }) {
    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm sm:text-base font-bold">{provider.name}</span>
                <PlanBadge plan={provider.plan} />
            </div>

            {provider.metered ? (
                <MeteredUsage usage={provider.metered} />
            ) : provider.windows.length > 0 ? (
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

            {provider.windowHistory && <AiUsageHistory history={provider.windowHistory} now={now} />}

            {provider.credit && (
                <div className="mt-auto space-y-2 border-t border-border pt-2.5">
                    <CreditRow credit={provider.credit} now={now} />
                    {provider.credit.ledger && <ClaudeCreditLedger ledger={provider.credit.ledger} />}
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
                {snapshot.providers
                    .filter((provider) => provider.id !== "typesafe" || provider.status !== "unconfigured")
                    .map((provider) => (
                        <ProviderCard key={provider.id} provider={provider} now={now} />
                    ))}
            </div>
        </section>
    )
}
