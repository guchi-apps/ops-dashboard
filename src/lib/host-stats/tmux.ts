import type { HostStatsHostView, HostStatsTmuxSession } from "@/types/host-stats"

/** デタッチのまま、これを超えて活動がないセッションを「放置」として色を変える */
export const TMUX_STALE_AFTER_SECONDS = 86_400

/**
 * running — シェル以外のコマンドが動いている（claude・node など）
 * idle    — シェルだけで止まっている
 * stale   — デタッチのまま24時間以上 活動がない
 */
export type TmuxSessionState = "running" | "idle" | "stale"

export interface TmuxSessionView extends HostStatsTmuxSession {
    hostId: string
    hostLabel: string
    state: TmuxSessionState
    /** セッションが作られてからの経過秒数。作成時刻が読めないホストでは undefined */
    ageSeconds?: number
    /** 最後に活動してからの経過秒数。エージェントが古いホストでは undefined */
    inactiveSeconds?: number
    /** その理由で止まっている秒数。回収の判定に乗らないセッションでは undefined */
    holdForSeconds?: number
    /** Claude Code のフックが最後にイベントを記録してからの経過秒数 */
    sinceLastEventSeconds?: number
}

export interface TmuxSummary {
    running: number
    idle: number
    stale: number
    /** 送信上限で切り捨てられた分を含むセッションの総数 */
    total: number
    /**
     * 送信上限で切り捨てられ、一覧に載らなかったセッション数。
     * 中身が分からないため running / idle / stale の内訳には入らない。
     */
    untracked: number
    /** tmux の情報を送ってきているホストが1つでもあるか（無ければ画面に出さない） */
    available: boolean
}

/** 状態ごとの表示名。バッジ・一覧・凡例で同じ言葉を使う */
export const TMUX_STATE_LABELS: Record<TmuxSessionState, string> = {
    running: "稼働中",
    idle: "待機中",
    stale: "放置",
}

const STATE_ORDER: Record<TmuxSessionState, number> = { running: 0, idle: 1, stale: 2 }

function elapsedSeconds(isoTime: string | undefined, nowMs: number): number | undefined {
    if (!isoTime) return undefined

    const time = Date.parse(isoTime)
    if (Number.isNaN(time)) return undefined

    return Math.max(0, Math.floor((nowMs - time) / 1000))
}

function getState(
    session: HostStatsTmuxSession,
    inactiveSeconds: number | undefined,
    ageSeconds: number | undefined
): TmuxSessionState {
    // busy を送ってこない世代のエージェントでは、アタッチの有無で代用するしかない
    const running = session.busy ?? session.attached
    if (running) return "running"

    if (session.attached) return "idle"

    const quietSeconds = inactiveSeconds ?? ageSeconds
    if (quietSeconds !== undefined && quietSeconds >= TMUX_STALE_AFTER_SECONDS) return "stale"

    return "idle"
}

/** 全ホストの tmux セッションを1つの一覧にまとめる。並びは 稼働中 → 待機中 → 放置 */
export function collectTmuxSessions(hosts: HostStatsHostView[], nowMs: number): TmuxSessionView[] {
    const sessions = hosts.flatMap((host) =>
        (host.latest.tmuxSessions ?? []).map((session) => {
            const ageSeconds = elapsedSeconds(session.createdAt, nowMs)
            const inactiveSeconds = elapsedSeconds(session.lastActivityAt, nowMs)

            return {
                ...session,
                hostId: host.id,
                hostLabel: host.label,
                ageSeconds,
                inactiveSeconds,
                holdForSeconds: elapsedSeconds(session.holdReasonAt, nowMs),
                sinceLastEventSeconds: elapsedSeconds(session.lastEventAt, nowMs),
                state: getState(session, inactiveSeconds, ageSeconds),
            }
        })
    )

    return sessions.sort((a, b) => {
        const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state]
        if (byState !== 0) return byState

        // 同じ状態なら、動きの新しいものを上に出す
        return (a.inactiveSeconds ?? a.ageSeconds ?? 0) - (b.inactiveSeconds ?? b.ageSeconds ?? 0)
    })
}

export function summarizeTmux(
    hosts: HostStatsHostView[],
    sessions: TmuxSessionView[]
): TmuxSummary {
    const count = (state: TmuxSessionState) =>
        sessions.filter((session) => session.state === state).length

    // エージェントは送るセッション数に上限があり、超えた分は一覧に載らない。
    // 総数まで一覧の長さで数えると、セッションが積み上がっていること自体が画面から消える
    const untracked = hosts.reduce((sum, host) => {
        const { tmuxSessions, tmuxSessionTotal } = host.latest
        if (tmuxSessions === undefined || tmuxSessionTotal === undefined) return sum
        return sum + Math.max(0, tmuxSessionTotal - tmuxSessions.length)
    }, 0)

    return {
        running: count("running"),
        idle: count("idle"),
        stale: count("stale"),
        total: sessions.length + untracked,
        untracked,
        available: hosts.some((host) => host.latest.tmuxSessions !== undefined),
    }
}
