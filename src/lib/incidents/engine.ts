import type { PushSendResult } from "@/lib/push/web-push"
import type { HostStatsHostView } from "@/types/host-stats"
import {
    evaluateHosts,
    evaluateIncidents,
    incidentSignature,
    type HostStates,
    type MonitorInputs,
} from "@/lib/incidents/evaluate"
import { buildHostMessage } from "@/lib/incidents/messages"
import type { PushMessage } from "@/lib/push/web-push"
import type { HostEvent, Incident, IncidentSnapshot } from "@/lib/incidents/types"

/** 通知履歴に残す件数 */
const MAX_EVENTS = 20

/** 届かなかった通知を再送し続ける上限。Pushの保持時間（1時間）を過ぎた障害通知は意味を失う */
const PENDING_EXPIRE_MS = 60 * 60 * 1000

/** 再送の間隔の最初の値と上限。失敗が続いても30秒周期の判定を詰まらせない */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60 * 1000

/** 送りたい通知。届くまで永続化して再送する */
export interface PendingPush {
    event: HostEvent
    attempts: number
    /** この時刻（ISO）より前には再送しない */
    retryAt?: string
}

/** `.data/incidents.json` に永続化する全状態。再デプロイ・再起動をまたいで通知を連発しないための記録 */
export interface IncidentState {
    seq: number
    signature: string
    computedAt: string
    hosts: HostStates
    incidents: Incident[]
    unavailable: string[]
    events: HostEvent[]
    pending: PendingPush[]
}

export const EMPTY_INCIDENT_STATE: IncidentState = {
    seq: 0,
    signature: "",
    computedAt: "",
    hosts: {},
    incidents: [],
    unavailable: [],
    events: [],
    pending: [],
}

export function toSnapshot(state: IncidentState): IncidentSnapshot {
    return {
        seq: state.seq,
        computedAt: state.computedAt,
        count: state.incidents.length,
        incidents: state.incidents,
        unavailable: state.unavailable,
        events: state.events,
    }
}

/**
 * 今回の観測で状態を1歩進める（入出力なし）。新しい出来事は履歴と再送待ちへ積む。
 *
 * 通番は件数・一覧が変わったか、通知する出来事があったときだけ進める。状態ファイルが失われても
 * 端末側の保存値より小さくならないよう、最初の値は現在の秒数から始める。
 */
export function advanceIncidentState(
    previous: IncidentState,
    input: { hosts: HostStatsHostView[]; monitors: MonitorInputs; now: number }
): IncidentState {
    const nowIso = new Date(input.now).toISOString()
    const { next: hosts, events } = evaluateHosts(input.hosts, previous.hosts, nowIso)
    const evaluation = evaluateIncidents({
        hosts: input.hosts,
        monitors: input.monitors,
        previous: previous.incidents,
        now: input.now,
    })

    const signature = incidentSignature(evaluation)
    const changed = signature !== previous.signature || events.length > 0
    const seq = changed
        ? previous.seq === 0
            ? Math.floor(input.now / 1000)
            : previous.seq + 1
        : previous.seq

    return {
        seq,
        signature,
        computedAt: nowIso,
        hosts,
        incidents: evaluation.incidents,
        unavailable: evaluation.unavailable,
        events: [...[...events].reverse(), ...previous.events].slice(0, MAX_EVENTS),
        pending: [...previous.pending, ...events.map((event) => ({ event, attempts: 0 }))],
    }
}

/**
 * 再送待ちの通知を送る。届いた（1台以上に受け付けられた）ものだけを待ちから外す。
 * 届かなかったものは間隔を空けて再送し、期限を過ぎたものは捨てる。送信が例外で落ちても次へ進む。
 */
export async function deliverPending(
    state: IncidentState,
    send: (message: PushMessage) => Promise<PushSendResult>,
    now: number
): Promise<IncidentState> {
    const remaining: PendingPush[] = []

    for (const item of state.pending) {
        if (now - new Date(item.event.at).getTime() > PENDING_EXPIRE_MS) continue
        if (item.retryAt && new Date(item.retryAt).getTime() > now) {
            remaining.push(item)
            continue
        }

        let delivered = false
        try {
            const message = buildHostMessage(item.event, { count: state.incidents.length, seq: state.seq })
            delivered = (await send(message)).delivered > 0
        } catch (error) {
            console.error("[incidents] 通知の送信に失敗しました:", error)
        }
        if (delivered) continue

        const attempts = item.attempts + 1
        const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
        remaining.push({ ...item, attempts, retryAt: new Date(now + wait).toISOString() })
    }

    return { ...state, pending: remaining }
}
