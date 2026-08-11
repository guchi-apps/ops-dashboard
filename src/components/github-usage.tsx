"use client"

import { useEffect, useState } from "react"
import { DashboardCard } from "@/components/dashboard-card"
import { SectionHeading } from "@/components/section-heading"
import { UsageBar } from "@/components/usage-bar"
import { formatRemaining, getElapsedPercent } from "@/lib/usage-format"
import type { GitHubActionsUsage, GitHubRateLimit, GitHubUsageSnapshot } from "@/types/github-usage"

/** サーバー側のキャッシュ（既定5分）に合わせた取得間隔 */
const REFRESH_INTERVAL_MS = 300_000

/** リセットまでの残り時間表示を進めるための再描画間隔 */
const TICK_INTERVAL_MS = 30_000

/** レート制限の枠の長さ（1時間）。経過位置の目印を出すのに使う */
const RATE_LIMIT_WINDOW_MS = 3_600_000

/** 内訳を並べるリポジトリ数の上限。これを超えた分はまとめて件数だけ出す */
const MAX_LISTED_REPOSITORIES = 6

function formatNumber(value: number): string {
    return value.toLocaleString("ja-JP")
}

function CardHeader({ title, badge }: { title: string; badge?: string }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm sm:text-base font-bold">{title}</span>
            {badge && (
                <span className="shrink-0 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-[10px] sm:text-xs font-semibold dark:bg-muted">
                    {badge}
                </span>
            )}
        </div>
    )
}

function CardFooter({ rows }: { rows: { label: string; value: string }[] }) {
    return (
        <div className="mt-auto space-y-0.5 border-t border-primary-foreground/20 pt-2 text-[10px] sm:text-xs text-primary-foreground/70 dark:border-border dark:text-muted-foreground">
            {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-2">
                    <span>{row.label}</span>
                    <span className="font-mono">{row.value}</span>
                </div>
            ))}
        </div>
    )
}

function RepositoryBreakdown({ actions }: { actions: GitHubActionsUsage }) {
    const listed = actions.repositories.slice(0, MAX_LISTED_REPOSITORIES)
    const hiddenCount = actions.repositories.length - listed.length

    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium">今月の実行時間</span>
                <span className="font-mono text-sm sm:text-base font-bold">
                    {formatNumber(actions.totalMinutes)}分
                </span>
            </div>

            {actions.repositories.length === 0 ? (
                <p className="text-[10px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                    今月はまだ実行されていません
                </p>
            ) : (
                <>
                    <p className="text-[10px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                        公開リポジトリのActionsは無制限に無料のため、無料枠を消費しない
                    </p>
                    <ul className="space-y-0.5 text-[10px] sm:text-xs">
                        {listed.map((repo) => (
                            <li key={repo.name} className="flex items-baseline justify-between gap-2">
                                <span className="min-w-0 truncate">
                                    {repo.name}
                                    {!repo.isPrivate && (
                                        <span className="ml-1 opacity-70">公開</span>
                                    )}
                                </span>
                                <span className="shrink-0 font-mono">{formatNumber(repo.minutes)}分</span>
                            </li>
                        ))}
                        {hiddenCount > 0 && (
                            <li className="opacity-70">他 {hiddenCount} リポジトリ</li>
                        )}
                    </ul>
                </>
            )}
        </div>
    )
}

function ActionsCard({ actions, now }: { actions: GitHubActionsUsage; now: number }) {
    const usedPercent =
        actions.allowanceLimitMinutes > 0
            ? Math.round((actions.allowanceMinutes / actions.allowanceLimitMinutes) * 1000) / 10
            : 0

    const period = new Date(actions.periodStartsAt).toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
    })

    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <CardHeader title="Actions" badge={period} />

            <UsageBar
                label="無料枠"
                usedPercent={usedPercent}
                elapsedPercent={getElapsedPercent(
                    new Date(actions.periodStartsAt).getTime(),
                    new Date(actions.resetsAt).getTime(),
                    now
                )}
                valueText={`残り ${formatNumber(
                    Math.max(0, actions.allowanceLimitMinutes - actions.allowanceMinutes)
                )}分`}
                usedText={`使用 ${formatNumber(actions.allowanceMinutes)} / ${formatNumber(
                    actions.allowanceLimitMinutes
                )}分`}
                remainingText={formatRemaining(actions.resetsAt, now)}
            />

            <RepositoryBreakdown actions={actions} />

            <CardFooter
                rows={[
                    { label: "今月の課金額", value: `$${actions.netAmountUsd.toFixed(2)}` },
                    // 無料枠は容量(MB)で決まるため割合は出せず、消費量の実績だけを添える
                    { label: "ストレージ", value: `${actions.storageGigabyteHours} GB時間` },
                ]}
            />
        </DashboardCard>
    )
}

function RateLimitCard({ rateLimit, now }: { rateLimit: GitHubRateLimit; now: number }) {
    const usedPercent =
        rateLimit.limit > 0 ? Math.round((rateLimit.used / rateLimit.limit) * 1000) / 10 : 0
    const resetsAtMs = new Date(rateLimit.resetsAt).getTime()

    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <CardHeader title="API レート制限" badge={`${formatNumber(rateLimit.limit)} req/時`} />

            <UsageBar
                label="1時間あたり"
                usedPercent={usedPercent}
                elapsedPercent={getElapsedPercent(resetsAtMs - RATE_LIMIT_WINDOW_MS, resetsAtMs, now)}
                valueText={`残り ${formatNumber(rateLimit.remaining)}`}
                usedText={`使用 ${formatNumber(rateLimit.used)} / ${formatNumber(rateLimit.limit)} req`}
                remainingText={formatRemaining(rateLimit.resetsAt, now)}
            />

            <CardFooter
                rows={[
                    {
                        label: "リセット時刻",
                        value: new Date(rateLimit.resetsAt).toLocaleTimeString("ja-JP", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                    },
                ]}
            />
        </DashboardCard>
    )
}

export function GitHubUsage() {
    const [snapshot, setSnapshot] = useState<GitHubUsageSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            try {
                const res = await fetch("/api/github-usage", { cache: "no-store" })
                if (!res.ok) throw new Error("Failed to fetch GitHub usage")

                const data = (await res.json()) as GitHubUsageSnapshot
                if (!cancelled) setSnapshot(data)
            } catch (error) {
                console.error("Failed to fetch GitHub usage:", error)
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

    // 未設定のときは、使わない環境で「未設定」のカードが出続けないようセクションごと隠す
    if (loading || !snapshot || snapshot.status === "unconfigured") return null

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="GitHub"
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
                    <p className="text-[11px] sm:text-xs text-primary-foreground/70 dark:text-muted-foreground">
                        {snapshot.message ?? "使用状況を取得できませんでした"}
                    </p>
                </DashboardCard>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    {snapshot.actions && <ActionsCard actions={snapshot.actions} now={now} />}
                    {snapshot.rateLimit && <RateLimitCard rateLimit={snapshot.rateLimit} now={now} />}
                </div>
            )}
        </section>
    )
}
