"use client"

import { createContext, useContext, useEffect, useMemo, useState } from "react"
import type { AiUsageSnapshot } from "@/types/ai-usage"
import type { GitHubUsageSnapshot } from "@/types/github-usage"
import type { HostStatsView } from "@/types/host-stats"
import type { OnePasswordUsageSnapshot } from "@/types/onepassword-usage"
import type { UptimeKumaMonitor } from "@/lib/uptime-kuma"
import type { UptimeRobotMonitor } from "@/lib/uptimerobot"

/** ホストのメトリクス。エージェントの送信間隔（既定1分）より短くても害はない */
const HOST_STATS_INTERVAL_MS = 30_000

/** 監視サービス。障害に気づくのが遅れない程度の間隔にする */
const MONITOR_INTERVAL_MS = 60_000

/** AI・GitHub・1Passwordの使用状況。サーバー側のキャッシュ（既定5分）に合わせる */
const USAGE_INTERVAL_MS = 300_000

/** リセットまでの残り時間や経過時間の表示を進めるための再描画間隔 */
const CLOCK_INTERVAL_MS = 30_000

/** サーバー側で取得済みの初期値。初回描画で監視の枠が空にならないようにする */
export interface DashboardInitialData {
    uptimeKuma: UptimeKumaMonitor[]
    uptimeRobot: UptimeRobotMonitor[]
}

interface DashboardData extends DashboardInitialData {
    hostStats: HostStatsView | null
    aiUsage: AiUsageSnapshot | null
    githubUsage: GitHubUsageSnapshot | null
    onepasswordUsage: OnePasswordUsageSnapshot | null
    /** 残り時間の計算に使う現在時刻。各コンポーネントが個別にタイマーを持たなくて済むよう配る */
    now: number
    /** いずれかのデータを最後に受け取った時刻（epoch ミリ秒）。未受信なら null */
    updatedAt: number | null
}

const DashboardDataContext = createContext<DashboardData | null>(null)

/**
 * ダッシュボードが使うデータをまとめて取得する。
 *
 * 画面上部のサマリーが全ソースを横断して集計するため、取得をコンポーネントごとに散らすと
 * 同じデータを二重に取りにいくことになる。取得はここに一本化し、各コンポーネントは表示だけを持つ。
 */
export function DashboardDataProvider({
    initial,
    children,
}: {
    initial: DashboardInitialData
    children: React.ReactNode
}) {
    const hostStats = usePolledJson<HostStatsView | null>(
        "/api/host-stats",
        HOST_STATS_INTERVAL_MS,
        selectAsIs,
        null
    )
    const aiUsage = usePolledJson<AiUsageSnapshot | null>(
        "/api/ai-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null
    )
    const githubUsage = usePolledJson<GitHubUsageSnapshot | null>(
        "/api/github-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null
    )
    const onepasswordUsage = usePolledJson<OnePasswordUsageSnapshot | null>(
        "/api/onepassword-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null
    )
    const uptimeKuma = usePolledJson<UptimeKumaMonitor[]>(
        "/api/uptime-kuma",
        MONITOR_INTERVAL_MS,
        selectMonitors,
        initial.uptimeKuma
    )
    const uptimeRobot = usePolledJson<UptimeRobotMonitor[]>(
        "/api/monitors",
        MONITOR_INTERVAL_MS,
        selectMonitors,
        initial.uptimeRobot
    )

    const now = useClock()

    const value = useMemo<DashboardData>(
        () => ({
            hostStats: hostStats.value,
            aiUsage: aiUsage.value,
            githubUsage: githubUsage.value,
            onepasswordUsage: onepasswordUsage.value,
            uptimeKuma: uptimeKuma.value,
            uptimeRobot: uptimeRobot.value,
            now,
            updatedAt: latest([
                hostStats.updatedAt,
                aiUsage.updatedAt,
                githubUsage.updatedAt,
                onepasswordUsage.updatedAt,
                uptimeKuma.updatedAt,
                uptimeRobot.updatedAt,
            ]),
        }),
        [hostStats, aiUsage, githubUsage, onepasswordUsage, uptimeKuma, uptimeRobot, now]
    )

    return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>
}

export function useDashboardData(): DashboardData {
    const value = useContext(DashboardDataContext)
    if (!value) throw new Error("DashboardDataProvider の中で使ってください")
    return value
}

interface PolledJson<T> {
    value: T
    /** 最後に取得できた時刻（epoch ミリ秒）。一度も取得できていなければ null */
    updatedAt: number | null
}

/** APIのレスポンスをそのまま使う（/api/host-stats など、本体がそのまま返ってくるもの） */
function selectAsIs<T>(payload: unknown): T {
    return payload as T
}

/** 監視系のAPIは { monitors: [...] } で包んで返ってくる */
function selectMonitors<T>(payload: unknown): T[] {
    return (payload as { monitors?: T[] }).monitors ?? []
}

function usePolledJson<T>(
    url: string,
    intervalMs: number,
    select: (payload: unknown) => T,
    initial: T
): PolledJson<T> {
    const [state, setState] = useState<PolledJson<T>>({ value: initial, updatedAt: null })

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            try {
                const res = await fetch(url, { cache: "no-store" })
                if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`)

                const payload: unknown = await res.json()
                if (cancelled) return

                setState({ value: select(payload), updatedAt: Date.now() })
            } catch (error) {
                // 取得に失敗しても直前の値を出し続ける（1回の失敗で画面が消えるのを避ける）
                console.error(`Failed to fetch ${url}:`, error)
            }
        }

        void load()
        const intervalId = setInterval(() => void load(), intervalMs)

        return () => {
            cancelled = true
            clearInterval(intervalId)
        }
    }, [url, intervalMs, select])

    return state
}

function useClock(): number {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        const intervalId = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS)
        return () => clearInterval(intervalId)
    }, [])

    return now
}

function latest(times: (number | null)[]): number | null {
    const known = times.filter((time): time is number => time !== null)
    return known.length > 0 ? Math.max(...known) : null
}
