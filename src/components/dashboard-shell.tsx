"use client"

import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { AiUsage } from "@/components/ai-usage"
import { useDashboardData, type RefreshState } from "@/components/dashboard-data"
import { GitHubUsage } from "@/components/github-usage"
import { HostCard } from "@/components/host-card"
import { HostStats } from "@/components/host-stats"
import { MonitorSections } from "@/components/monitor-sections"
import { MonitorTiles, getMonitorStatusText } from "@/components/monitor-tiles"
import { OnePasswordUsage } from "@/components/onepassword-usage"
import { StatusStrip } from "@/components/status-strip"
import { StatusBadge } from "@/components/status-badge"
import { SwipeTabs } from "@/components/swipe-tabs"
import { TmuxLegend, TmuxSessionList, TmuxSessionTable } from "@/components/tmux-sessions"
import { Button } from "@/components/ui/button"
import { AiUsageCompact, GitHubUsageCompact } from "@/components/usage-compact"
import { buildSummaryChips } from "@/lib/dashboard-summary"
import { formatAge } from "@/lib/host-stats/format"
import { collectTmuxSessions, summarizeTmux } from "@/lib/host-stats/tmux"
import { cn } from "@/lib/utils"

/** 選んだタブは端末ごとに覚える。毎回「概要」に戻ると、見たい場所へ都度たどり直すことになる */
const ACTIVE_TAB_STORAGE_KEY = "ops-dashboard:active-tab"

type TabId = "overview" | "hosts" | "tmux" | "usage" | "monitors"

const TAB_IDS: TabId[] = ["overview", "hosts", "tmux", "usage", "monitors"]

/**
 * 選択中のタブ。localStorage はサーバー側に無いため、外部ストアとして読む。
 * useState + useEffect で復元すると、初期HTMLと食い違ううえ余分な再描画を挟むことになる。
 */
const tabListeners = new Set<() => void>()

function subscribeActiveTab(listener: () => void): () => void {
    tabListeners.add(listener)
    return () => {
        tabListeners.delete(listener)
    }
}

function getStoredTab(): TabId {
    const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return stored && TAB_IDS.includes(stored as TabId) ? (stored as TabId) : "overview"
}

/** サーバー側の描画では常に概要。端末に保存した選択はハイドレート後に反映される */
function getInitialTab(): TabId {
    return "overview"
}

function storeActiveTab(tab: TabId) {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
    for (const listener of tabListeners) listener()
}

const TAB_LABELS: Record<TabId, string> = {
    overview: "概要",
    hosts: "ホスト",
    tmux: "tmux",
    usage: "AI・GitHub・1Password",
    monitors: "監視",
}

/**
 * 狭い画面用の短い名前。長い名前のままだと5つのタブが画面に収まらず、
 * 右端の「監視」がスクロールしないと見えなくなる（#96）
 */
const TAB_SHORT_LABELS: Partial<Record<TabId, string>> = {
    usage: "利用枠",
}

/**
 * ヘッダーの更新時刻と更新ボタン。
 *
 * 押すとホスト・AI・GitHub・1Password・監視をまとめて取り直す。押した結果は時刻が進むことで分かるため、
 * 狭い画面でも時刻だけは出す（ボタンはアイコンのみにして幅を詰める）。
 */
function RefreshControl({
    updatedAt,
    state,
    cooldownSeconds,
    onRefresh,
}: {
    updatedAt: number | null
    state: RefreshState
    cooldownSeconds: number
    onRefresh: () => void
}) {
    const time = updatedAt
        ? new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
        : null
    const busy = state === "refreshing"
    const failed = state === "error"

    const label = busy
        ? "更新中"
        : cooldownSeconds > 0
          ? `あと${cooldownSeconds}秒で更新できます`
          : "最新の状態に更新"

    return (
        <>
            {(time || failed) && (
                <span
                    aria-live="polite"
                    className={cn(
                        "font-mono text-[11px]",
                        failed ? "text-destructive" : "text-muted-foreground"
                    )}
                >
                    {failed ? (
                        <>
                            <span className="sm:hidden">更新できません</span>
                            <span className="hidden sm:inline">
                                更新できませんでした{time && `（${time} 時点の値）`}
                            </span>
                        </>
                    ) : (
                        `${time} 更新`
                    )}
                </span>
            )}
            <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onRefresh}
                disabled={busy || cooldownSeconds > 0}
                aria-label={label}
                title={label}
                className="px-2 sm:px-3"
            >
                <RefreshCw
                    className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")}
                    aria-hidden
                />
                <span className="hidden sm:inline">
                    {busy ? "更新中" : cooldownSeconds > 0 ? cooldownSeconds : "更新"}
                </span>
            </Button>
        </>
    )
}

/** 概要タブに並べるカードの外枠。見出しの高さを揃え、中身だけを差し替える */
function Panel({
    title,
    trailing,
    className,
    children,
}: {
    title: string
    trailing?: React.ReactNode
    className?: string
    children: React.ReactNode
}) {
    return (
        <section className={cn("rounded-xl border border-border bg-card p-3", className)}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-bold">{title}</h2>
                {trailing}
            </div>
            {children}
        </section>
    )
}

export function DashboardShell({
    userEmail,
    addMonitorUrl,
}: {
    userEmail: string
    addMonitorUrl: string | null
}) {
    const data = useDashboardData()
    const {
        hostStats,
        aiUsage,
        githubUsage,
        onepasswordUsage,
        uptimeKuma,
        uptimeRobot,
        now,
        updatedAt,
        refresh,
        refreshState,
        refreshCooldownSeconds,
    } = data

    const activeTab = useSyncExternalStore(subscribeActiveTab, getStoredTab, getInitialTab)

    // スワイプで切り替えたときにタブ帯が動かないと、いまどこにいるのかが分からなくなる（#136）
    const tabListRef = useRef<HTMLDivElement>(null)
    const activeIndex = TAB_IDS.indexOf(activeTab)

    const goToTabAt = useCallback((index: number) => {
        const tab = TAB_IDS[index]
        if (tab) storeActiveTab(tab)
    }, [])

    const goPrevious = useCallback(() => goToTabAt(activeIndex - 1), [goToTabAt, activeIndex])
    const goNext = useCallback(() => goToTabAt(activeIndex + 1), [goToTabAt, activeIndex])

    useEffect(() => {
        const list = tabListRef.current
        const button = list?.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`)
        if (!list || !button) return

        // 選択中のタブが帯からはみ出していたら、少し余白を残して見える位置まで寄せる
        const listRect = list.getBoundingClientRect()
        const buttonRect = button.getBoundingClientRect()
        if (buttonRect.left < listRect.left) {
            list.scrollBy({ left: buttonRect.left - listRect.left - 16, behavior: "smooth" })
        } else if (buttonRect.right > listRect.right) {
            list.scrollBy({ left: buttonRect.right - listRect.right + 16, behavior: "smooth" })
        }
    }, [activeTab])

    const hosts = useMemo(() => hostStats?.hosts ?? [], [hostStats])
    const tmuxSessions = useMemo(() => collectTmuxSessions(hosts, now), [hosts, now])
    const tmuxSummary = useMemo(() => summarizeTmux(hosts, tmuxSessions), [hosts, tmuxSessions])
    const monitorStatus = getMonitorStatusText(uptimeKuma, uptimeRobot)

    const chips = useMemo(
        () =>
            buildSummaryChips({
                hostStats,
                tmuxSessions,
                uptimeKuma,
                uptimeRobot,
                aiUsage,
                githubUsage,
                onepasswordUsage,
            }),
        [hostStats, tmuxSessions, uptimeKuma, uptimeRobot, aiUsage, githubUsage, onepasswordUsage]
    )

    const counts: Partial<Record<TabId, number>> = {
        hosts: hosts.length,
        tmux: tmuxSummary.total,
        monitors: uptimeKuma.length + uptimeRobot.length,
    }

    // ホストが2台以上なら3列（ホスト・ホスト・tmux）、1台なら2列で割り付ける
    const hostSpan = hosts.length >= 2 ? "xl:col-span-4" : "xl:col-span-6"

    // 全体の高さは body 側の min-h-screen に任せる。
    // ここでも画面高を確保すると、フッターの分だけ必ずスクロールが出てしまう
    return (
        <div className="mx-auto w-full max-w-[1600px] px-3 py-3 sm:px-5 sm:py-4">
            <header className="mb-2.5 flex items-center gap-2 sm:gap-3">
                <span className="h-5 w-1 shrink-0 rounded-full bg-highlight" aria-hidden />
                <h1 className="shrink-0 text-base font-bold sm:text-lg">ops-dashboard</h1>
                <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
                    <span className="hidden items-center gap-1.5 text-[9px] font-bold tracking-[0.16em] text-emerald-600 sm:inline-flex dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                        LIVE
                    </span>
                    <RefreshControl
                        updatedAt={updatedAt}
                        state={refreshState}
                        cooldownSeconds={refreshCooldownSeconds}
                        onRefresh={refresh}
                    />
                    <span className="hidden max-w-[16rem] truncate text-xs text-muted-foreground lg:inline">
                        {userEmail}
                    </span>
                    <form action="/auth/signout" method="POST">
                        <Button variant="outline" size="sm" type="submit">
                            ログアウト
                        </Button>
                    </form>
                </div>
            </header>

            <StatusStrip chips={chips} />

            <div
                ref={tabListRef}
                role="tablist"
                aria-label="表示の切り替え"
                className="-mx-3 mb-2.5 mt-1.5 flex gap-1 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0"
            >
                {TAB_IDS.map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        role="tab"
                        data-tab-id={tab}
                        aria-selected={activeTab === tab}
                        onClick={() => storeActiveTab(tab)}
                        className={cn(
                            "shrink-0 border-b-2 px-3 py-1.5 text-[13px] transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            activeTab === tab
                                ? "border-highlight font-bold text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <span className="sm:hidden">{TAB_SHORT_LABELS[tab] ?? TAB_LABELS[tab]}</span>
                        <span className="hidden sm:inline">{TAB_LABELS[tab]}</span>
                        {counts[tab] !== undefined && counts[tab]! > 0 && (
                            <span className="ml-1.5 text-[10px] text-muted-foreground">{counts[tab]}</span>
                        )}
                    </button>
                ))}
            </div>

            <SwipeTabs
                label={TAB_LABELS[activeTab]}
                contentKey={activeTab}
                canGoPrevious={activeIndex > 0}
                canGoNext={activeIndex < TAB_IDS.length - 1}
                onPrevious={goPrevious}
                onNext={goNext}
            >
                {activeTab === "overview" && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
                        {hosts.map((host) => (
                            <div key={host.id} className={hostSpan}>
                                <HostCard host={host} historyHours={hostStats?.historyHours ?? 24} />
                            </div>
                        ))}

                        {tmuxSummary.available && (
                            <Panel
                                title="tmux セッション"
                                className={hosts.length >= 2 ? "xl:col-span-4" : "xl:col-span-6"}
                                trailing={
                                    <>
                                        <StatusBadge tone={tmuxSummary.running > 0 ? "ok" : "neutral"}>
                                            稼働 {tmuxSummary.running}
                                        </StatusBadge>
                                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                            入力待ち {tmuxSummary.waiting} · 待機{" "}
                                            {tmuxSummary.idle + tmuxSummary.stale} · 全
                                            {tmuxSummary.total}件
                                            {/* 上限で届かなかった分は一覧に出せないので、内訳が合わない理由を書いておく */}
                                            {tmuxSummary.untracked > 0 &&
                                                `（うち ${tmuxSummary.untracked}件 未取得）`}
                                        </span>
                                    </>
                                }
                            >
                                <TmuxSessionList
                                    sessions={tmuxSessions}
                                    withHostLabel={
                                        new Set(tmuxSessions.map((session) => session.hostId)).size > 1
                                    }
                                />
                            </Panel>
                        )}

                        {aiUsage && (
                            <Panel
                                title="AI 使用状況"
                                className="xl:col-span-3"
                                trailing={
                                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                        {new Date(aiUsage.fetchedAt).toLocaleTimeString("ja-JP", {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}{" "}
                                        時点
                                    </span>
                                }
                            >
                                <AiUsageCompact snapshot={aiUsage} now={now} />
                            </Panel>
                        )}

                        {githubUsage && githubUsage.status !== "unconfigured" && (
                            <Panel
                                title="GitHub"
                                className="xl:col-span-3"
                                trailing={
                                    <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                                        {githubUsage.org ?? ""}
                                    </span>
                                }
                            >
                                <GitHubUsageCompact snapshot={githubUsage} now={now} />
                            </Panel>
                        )}

                        <Panel
                            title="監視"
                            className="md:col-span-2 xl:col-span-6"
                            trailing={
                                <>
                                    {monitorStatus.down > 0 && (
                                        <StatusBadge tone="danger">DOWN {monitorStatus.down}</StatusBadge>
                                    )}
                                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                        {monitorStatus.text}
                                    </span>
                                </>
                            }
                        >
                            <MonitorTiles kuma={uptimeKuma} robot={uptimeRobot} />
                        </Panel>
                    </div>
                )}

                {activeTab === "hosts" && (
                    <div className="space-y-5">
                        <HostStats />
                    </div>
                )}

                {activeTab === "tmux" && (
                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                        <Panel
                            title="tmux セッション"
                            className="xl:col-span-2"
                            trailing={
                                <>
                                    <StatusBadge tone={tmuxSummary.running > 0 ? "ok" : "neutral"}>
                                        稼働 {tmuxSummary.running}
                                    </StatusBadge>
                                    {/*
                                        セッションを詳しく見る場所なので、総数まで出す（#61）。
                                        エージェントは送信を上限で打ち切るため、一覧の行数だけでは
                                        積み上がっていることに気づけない
                                    */}
                                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                        入力待ち {tmuxSummary.waiting} · 待機 {tmuxSummary.idle} · 放置{" "}
                                        {tmuxSummary.stale} · 全{tmuxSummary.total}件
                                        {tmuxSummary.untracked > 0 &&
                                            `（うち ${tmuxSummary.untracked}件 未取得）`}
                                    </span>
                                </>
                            }
                        >
                            <TmuxSessionTable sessions={tmuxSessions} />
                            <div className="mt-3">
                                <TmuxLegend />
                            </div>
                        </Panel>

                        <Panel title="内訳">
                            <TmuxBreakdown sessions={tmuxSessions} hosts={hosts.map((host) => host.label)} />
                        </Panel>
                    </div>
                )}

                {activeTab === "usage" && (
                    <div className="space-y-5">
                        <AiUsage />
                        <GitHubUsage />
                        <OnePasswordUsage />
                    </div>
                )}

                {activeTab === "monitors" && <MonitorSections addMonitorUrl={addMonitorUrl} />}
            </SwipeTabs>
        </div>
    )
}

/** tmuxタブの右側。ホスト別の内訳と、実行中コマンドの多い順を出す */
function TmuxBreakdown({
    sessions,
    hosts,
}: {
    sessions: ReturnType<typeof collectTmuxSessions>
    hosts: string[]
}) {
    const commandCounts = new Map<string, number>()
    for (const session of sessions) {
        for (const command of session.commands ?? []) {
            commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1)
        }
    }

    const stale = sessions.filter((session) => session.state === "stale")

    return (
        <div className="space-y-3 text-[11px]">
            <div className="space-y-1">
                {hosts.map((host) => {
                    const forHost = sessions.filter((session) => session.hostLabel === host)
                    const running = forHost.filter((session) => session.state === "running").length
                    const waiting = forHost.filter((session) => session.state === "waiting").length

                    return (
                        <div key={host} className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">{host}</span>
                            <span className="font-mono">
                                {forHost.length === 0
                                    ? "セッションなし"
                                    : `稼働 ${running} · 入力待ち ${waiting} · 待機 ${
                                          forHost.length - running - waiting
                                      }`}
                            </span>
                        </div>
                    )
                })}
            </div>

            {commandCounts.size > 0 && (
                <div className="border-t border-border pt-2.5">
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                        実行中コマンド
                    </div>
                    <div className="space-y-1">
                        {[...commandCounts.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .map(([command, count]) => (
                                <div key={command} className="flex items-baseline justify-between gap-2">
                                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px]">
                                        {command}
                                    </span>
                                    <span className="font-mono text-muted-foreground">
                                        {count}セッション
                                    </span>
                                </div>
                            ))}
                    </div>
                </div>
            )}

            <div className="border-t border-border pt-2.5">
                <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    放置しているセッション
                </div>
                {stale.length === 0 ? (
                    <p className="text-muted-foreground">ありません</p>
                ) : (
                    <div className="space-y-1">
                        {stale.map((session) => (
                            <div
                                key={`${session.hostId}/${session.name}`}
                                className="flex items-baseline justify-between gap-2"
                            >
                                <span className="min-w-0 truncate font-mono">{session.name}</span>
                                <span className="shrink-0 font-mono text-amber-600 dark:text-amber-400">
                                    {session.inactiveSeconds !== undefined
                                        ? formatAge(session.inactiveSeconds)
                                        : "-"}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
