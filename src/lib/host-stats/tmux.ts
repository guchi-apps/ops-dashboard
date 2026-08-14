import type { HostStatsHostView, HostStatsTmuxSession } from "@/types/host-stats"

/** デタッチのまま、これを超えて活動がないセッションを「放置」として色を変える */
export const TMUX_STALE_AFTER_SECONDS = 86_400

/**
 * コマンドは起動したままだが、これを超えて画面が動いていないセッションを「入力待ち」として分ける。
 *
 * claude は起動しっぱなしが常態のため、プロセスの有無だけでは手が止まっているセッションを見分けられない。
 * 処理中は画面が描き変わり続けるので、tmux の最終活動時刻が止まったかどうかを代わりの手がかりにする。
 */
export const TMUX_WAITING_AFTER_SECONDS = 60

/**
 * running — シェル以外のコマンドが動いていて、画面も動いている（処理中）
 * waiting — コマンドは動いているが画面が止まっている（プロンプトで入力を待っている）
 * idle    — シェルだけで止まっている
 * stale   — デタッチのまま24時間以上 活動がない
 */
export type TmuxSessionState = "running" | "waiting" | "idle" | "stale"

export interface TmuxSessionView extends HostStatsTmuxSession {
    hostId: string
    hostLabel: string
    state: TmuxSessionState
    /** セッションが作られてからの経過秒数。作成時刻が読めないホストでは undefined */
    ageSeconds?: number
    /** 最後に活動してからの経過秒数。エージェントが古いホストでは undefined */
    inactiveSeconds?: number
}

export interface TmuxSummary {
    running: number
    waiting: number
    idle: number
    stale: number
    total: number
    /** tmux の情報を送ってきているホストが1つでもあるか（無ければ画面に出さない） */
    available: boolean
}

/** 状態ごとの表示名。バッジ・一覧・凡例で同じ言葉を使う */
export const TMUX_STATE_LABELS: Record<TmuxSessionState, string> = {
    running: "稼働中",
    waiting: "入力待ち",
    idle: "待機中",
    stale: "放置",
}

const STATE_ORDER: Record<TmuxSessionState, number> = {
    running: 0,
    waiting: 1,
    idle: 2,
    stale: 3,
}

function elapsedSeconds(isoTime: string | undefined, nowMs: number): number | undefined {
    if (!isoTime) return undefined

    const time = Date.parse(isoTime)
    if (Number.isNaN(time)) return undefined

    return Math.max(0, Math.floor((nowMs - time) / 1000))
}

/**
 * 「入力待ちか」を測るときの基準時刻。ホストがそのレポートを作った時刻を使う。
 *
 * 画面の現在時刻で測ると、次のレポートが届くまでのあいだ経過だけが伸びていくため、
 * いま動いているセッションでもしきい値を越えてしまい、レポートが届くたびに状態がちらつく。
 * 収集時刻はホスト自身の時計で、最終活動時刻と同じ時計のため、ホストとサーバーの時計ずれも入らない。
 */
function reportTime(host: HostStatsHostView, nowMs: number): number {
    const collected = Date.parse(host.latest.collectedAt ?? "")
    if (!Number.isNaN(collected)) return collected

    // 収集時刻を送ってこない世代のエージェント向け。時計ずれの分だけ精度は落ちる
    const received = Date.parse(host.latest.receivedAt)
    return Number.isNaN(received) ? nowMs : received
}

function getState(
    session: HostStatsTmuxSession,
    quietAtReportSeconds: number | undefined,
    inactiveSeconds: number | undefined,
    ageSeconds: number | undefined
): TmuxSessionState {
    // busy を送ってこない世代のエージェントでは、アタッチの有無で代用するしかない
    const busy = session.busy ?? session.attached

    // 最終活動を送ってこない世代のエージェントでは、処理中か入力待ちかを見分けられない。
    // その場合は今までどおり、コマンドが動いていれば稼働中として扱う
    const screenMoving =
        quietAtReportSeconds === undefined || quietAtReportSeconds < TMUX_WAITING_AFTER_SECONDS
    if (busy && screenMoving) return "running"

    // アタッチ中は目の前で開いているセッションなので、放置には落とさない
    const quietSeconds = inactiveSeconds ?? ageSeconds
    const longQuiet = quietSeconds !== undefined && quietSeconds >= TMUX_STALE_AFTER_SECONDS
    if (!session.attached && longQuiet) return "stale"

    return busy ? "waiting" : "idle"
}

/** 作成時刻を読めないセッションは、新しさで比べられないため末尾に回す */
function sortAge(session: TmuxSessionView): number {
    return session.ageSeconds ?? Number.MAX_SAFE_INTEGER
}

/**
 * 全ホストの tmux セッションを1つの一覧にまとめる。
 * 並びは 稼働中 → 入力待ち → 待機中 → 放置 で、同じ状態のなかでは あとから作ったセッションが上。
 */
export function collectTmuxSessions(hosts: HostStatsHostView[], nowMs: number): TmuxSessionView[] {
    const sessions = hosts.flatMap((host) => {
        const reportMs = reportTime(host, nowMs)

        return (host.latest.tmuxSessions ?? []).map((session) => {
            const ageSeconds = elapsedSeconds(session.createdAt, nowMs)
            const inactiveSeconds = elapsedSeconds(session.lastActivityAt, nowMs)
            const quietAtReportSeconds = elapsedSeconds(session.lastActivityAt, reportMs)

            return {
                ...session,
                hostId: host.id,
                hostLabel: host.label,
                ageSeconds,
                inactiveSeconds,
                state: getState(session, quietAtReportSeconds, inactiveSeconds, ageSeconds),
            }
        })
    })

    return sessions.sort((a, b) => {
        const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state]
        if (byState !== 0) return byState

        // 同じ状態なら、あとから起動したセッションを上に出す。
        // 最終活動の新しい順にすると、見るたびに行が入れ替わって目的のセッションを追えない。
        return sortAge(a) - sortAge(b)
    })
}

export function summarizeTmux(
    hosts: HostStatsHostView[],
    sessions: TmuxSessionView[]
): TmuxSummary {
    const count = (state: TmuxSessionState) =>
        sessions.filter((session) => session.state === state).length

    return {
        running: count("running"),
        waiting: count("waiting"),
        idle: count("idle"),
        stale: count("stale"),
        total: sessions.length,
        available: hosts.some((host) => host.latest.tmuxSessions !== undefined),
    }
}
