import fs from "fs/promises"
import path from "path"
import { getStatusHubAccess } from "@/lib/access/status-hub"
import { getHostLatestViews, writeFileAtomic } from "@/lib/host-stats/store"
import { createSingleFlight } from "@/lib/usage-cache"
import { fetchUptimeKumaDashboardMonitors } from "@/lib/uptime-kuma"
import { fetchUptimeRobotMonitorsServer } from "@/lib/uptimerobot"
import {
    advanceIncidentState,
    deliverPending,
    EMPTY_INCIDENT_STATE,
    toSnapshot,
    type IncidentState,
} from "@/lib/incidents/engine"
import type { MonitorInputs } from "@/lib/incidents/evaluate"
import { isHostAlertRecipient } from "@/lib/incidents/recipients"
import type { IncidentSnapshot } from "@/lib/incidents/types"
import { isWebPushConfigured, sendPushWhere } from "@/lib/push/web-push"

/**
 * ホスト停止・再起動の検知と未解消エラー件数の更新（#495）の入出力部分。
 * 判定は `engine.ts` / `evaluate.ts`（純関数）。ここは状態ファイルの読み書き・監視の取得・送信を担う。
 */

/** 監視（Kuma・UptimeRobot）の取得を使い回す時間。ホストの判定（30秒）のたびには取りにいかない */
const MONITOR_CACHE_MS = 90_000

/** 保存済みの状態をそのまま返してよい古さ。これを超えたら取り直す（定期処理が止まっていたとき） */
const SNAPSHOT_MAX_AGE_MS = 90_000

function getStatePath(): string {
    return process.env.INCIDENTS_STATE_PATH || path.join(process.cwd(), ".data", "incidents.json")
}

export async function readIncidentState(): Promise<IncidentState> {
    try {
        const parsed = JSON.parse(await fs.readFile(getStatePath(), "utf8")) as Partial<IncidentState> | null
        if (!parsed || typeof parsed !== "object") return EMPTY_INCIDENT_STATE
        return { ...EMPTY_INCIDENT_STATE, ...parsed }
    } catch {
        // 初回・壊れたファイルは「まだ何も通知していない」として扱う（初回の観測では通知しない）
        return EMPTY_INCIDENT_STATE
    }
}

async function writeIncidentState(state: IncidentState): Promise<void> {
    await writeFileAtomic(getStatePath(), `${JSON.stringify(state, null, 2)}\n`)
}

const globalForMonitors = globalThis as unknown as {
    __incidentMonitors?: { at: number; value: MonitorInputs }
    __incidentMonitorFlight?: ReturnType<typeof createSingleFlight<MonitorInputs>>
}

async function loadMonitors(now: number): Promise<MonitorInputs> {
    const cached = globalForMonitors.__incidentMonitors
    if (cached && now - cached.at < MONITOR_CACHE_MS) return cached.value

    globalForMonitors.__incidentMonitorFlight ??= createSingleFlight<MonitorInputs>()
    return globalForMonitors.__incidentMonitorFlight(async () => {
        const [kuma, robot] = await Promise.all([
            fetchUptimeKumaDashboardMonitors(),
            fetchUptimeRobotMonitorsServer(),
        ])
        const value = { kuma, robot }
        globalForMonitors.__incidentMonitors = { at: Date.now(), value }
        return value
    })
}

/** 同時に2つの判定を走らせない（状態ファイルの読み書きと、同じ通知の二重送信を避ける） */
const globalForRun = globalThis as unknown as { __incidentRun?: Promise<IncidentSnapshot> }

/**
 * 1回分の判定。状態を進めて保存し、届いていない通知を送る。
 * 通知の失敗は状態を壊さず、次の周期で再送する。呼び出し元（定期処理・画面のGET）を止めない。
 */
export function runIncidentCheck(): Promise<IncidentSnapshot> {
    if (globalForRun.__incidentRun) return globalForRun.__incidentRun

    const run = (async () => {
        const now = Date.now()
        const [previous, hosts, monitors] = await Promise.all([
            readIncidentState(),
            getHostLatestViews(now),
            loadMonitors(now),
        ])

        // 先に保存する。送信の途中でプロセスが落ちても、検知した出来事は再送待ちに残る
        let state = advanceIncidentState(previous, { hosts, monitors, now })
        await writeIncidentState(state)

        if (state.pending.length > 0 && isWebPushConfigured()) {
            state = await deliverPending(
                state,
                (message) =>
                    sendPushWhere(
                        (subscription) =>
                            isHostAlertRecipient(subscription, (email) => getStatusHubAccess(email).allowed),
                        message
                    ),
                now
            )
            await writeIncidentState(state)
        }

        return toSnapshot(state)
    })().finally(() => {
        globalForRun.__incidentRun = undefined
    })

    globalForRun.__incidentRun = run
    return run
}

/** 画面・起動時の同期用。保存済みの状態が新しければそれを返し、古ければ判定し直す */
export async function getIncidentSnapshot(): Promise<IncidentSnapshot> {
    const state = await readIncidentState()
    const age = Date.now() - new Date(state.computedAt).getTime()
    if (state.computedAt && age < SNAPSHOT_MAX_AGE_MS) return toSnapshot(state)
    return runIncidentCheck()
}
