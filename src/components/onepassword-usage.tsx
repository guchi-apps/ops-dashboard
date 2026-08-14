"use client"

import { DashboardCard } from "@/components/dashboard-card"
import { useDashboardData } from "@/components/dashboard-data"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent, getRateLimitUsedPercent } from "@/lib/usage-format"
import type { OnePasswordLimitType, OnePasswordRateLimit } from "@/types/onepassword-usage"

/** 枠の長さ。トークン単位は1時間、アカウント全体は24時間で数える */
const WINDOW_MS: Record<OnePasswordLimitType, number> = {
    token: 3_600_000,
    account: 86_400_000,
}

const ACTION_LABELS: Record<string, string> = {
    read: "読み取り",
    write: "書き込み",
    read_write: "読み書き",
}

function formatNumber(value: number): string {
    return value.toLocaleString("ja-JP")
}

function LimitBar({ limit, now }: { limit: OnePasswordRateLimit; now: number }) {
    const resetsAtMs = limit.resetsAt ? new Date(limit.resetsAt).getTime() : null

    return (
        <UsageBar
            label={ACTION_LABELS[limit.action] ?? limit.action}
            usedPercent={getRateLimitUsedPercent(limit)}
            elapsedPercent={
                resetsAtMs === null
                    ? null
                    : getElapsedPercent(resetsAtMs - WINDOW_MS[limit.type], resetsAtMs, now)
            }
            valueText={`残り ${formatNumber(limit.remaining)}`}
            usedText={`使用 ${formatNumber(limit.used)} / ${formatNumber(limit.limit)} 回`}
            remainingText={limit.resetsAt ? formatRemaining(limit.resetsAt, now) : "まだ使っていません"}
        />
    )
}

function LimitCard({
    title,
    badge,
    description,
    limits,
    now,
}: {
    title: string
    badge: string
    description: string
    limits: OnePasswordRateLimit[]
    now: number
}) {
    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm sm:text-base font-bold">{title}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] sm:text-xs font-semibold">
                    {badge}
                </span>
            </div>

            {limits.map((limit) => (
                <LimitBar key={limit.action} limit={limit} now={now} />
            ))}

            <p className="mt-auto border-t border-border pt-2 text-[10px] sm:text-xs text-muted-foreground">
                {description}
            </p>
        </DashboardCard>
    )
}

export function OnePasswordUsage() {
    const { onepasswordUsage: snapshot, now } = useDashboardData()

    // 未設定のときは、使わない環境で「未設定」のカードが出続けないようセクションごと隠す
    if (!snapshot || snapshot.status === "unconfigured") return null

    const tokenLimits = snapshot.limits.filter((limit) => limit.type === "token")
    const accountLimits = snapshot.limits.filter((limit) => limit.type === "account")

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="1Password"
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

            {snapshot.status === "error" ? (
                <DashboardCard className="px-3 py-3 sm:px-4 sm:py-4">
                    <p className="text-[11px] sm:text-xs text-muted-foreground">
                        {snapshot.message ?? "使用状況を取得できませんでした"}
                    </p>
                </DashboardCard>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    {tokenLimits.length > 0 && (
                        <LimitCard
                            title="サービスアカウント"
                            badge="1時間あたり"
                            description="デプロイやCIがシークレットを読むたびに消費する。このトークン単位で数える"
                            limits={tokenLimits}
                            now={now}
                        />
                    )}
                    {accountLimits.length > 0 && (
                        <LimitCard
                            title="アカウント全体"
                            badge="24時間あたり"
                            description="全サービスアカウントの合計。ここを使い切ると、どのアプリのデプロイも通らなくなる"
                            limits={accountLimits}
                            now={now}
                        />
                    )}
                </div>
            )}
        </section>
    )
}
