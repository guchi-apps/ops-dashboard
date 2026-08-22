import { formatAge, formatEta } from "@/lib/host-stats/format"
import type { HostStatsHostView, HostStatsTimer } from "@/types/host-stats"

/**
 * 定期ジョブ（systemd timer）が正常かどうかの判定（#75）。
 *
 * 画面（サマリー・ホストカード）と通知（src/lib/host-stats/timer-alerts.ts）で同じ判断を使う。
 * 判定材料はエージェントが送ってきたスナップショットだけで、ここでは systemd に問い合わせない。
 */

/** 予定時刻をこの秒数だけ過ぎても発火していなければ「未実行」とみなす */
const DEFAULT_GRACE_SECONDS = 3600

export type TimerState =
    /** 直近の実行が成功している */
    | "ok"
    /** いま実行中 */
    | "running"
    /** 直近の実行が失敗した */
    | "failed"
    /** 予定時刻＋猶予を過ぎても実行されていない */
    | "overdue"
    /** タイマーが止まっている・無効になっている */
    | "stopped"
    /** ユニットが存在しない */
    | "missing"
    /** 状態を取得できなかった（ジョブの異常ではない） */
    | "unknown"

export interface TimerStatus {
    timer: HostStatsTimer
    state: TimerState
    /** 異常として扱うか。unknown は誤検知になるため異常に数えない */
    abnormal: boolean
    /** 画面と通知に出す、状態を一言で表す文字列 */
    label: string
    /** その根拠（「exit 1 で終了」「予定より 3時間 遅れ」など） */
    detail?: string
}

export function getTimerGraceSeconds(): number {
    const parsed = Number.parseInt(process.env.HOST_STATS_TIMER_GRACE_SECONDS ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_SECONDS
}

/**
 * 同じユニットの失敗を何回続けて観測したら通知するか。
 * 一時的な失敗で鳴らしたくない場合に上げる（既定は1回目から鳴らす）。
 */
export function getTimerFailureThreshold(): number {
    const parsed = Number.parseInt(process.env.HOST_STATS_TIMER_FAILURE_THRESHOLD ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function toEpochMs(value: string | undefined): number | undefined {
    if (!value) return undefined
    const time = new Date(value).getTime()
    return Number.isFinite(time) ? time : undefined
}

/** 「3時間12分」のような遅れ幅。分未満は切り捨てる */
function formatDelay(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}分`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}時間${minutes % 60}分`
    return `${Math.floor(hours / 24)}日${hours % 24}時間`
}

/**
 * タイマー1本の状態を判定する。
 *
 * 判定の順番には意味がある。ユニットが消えていれば実行結果を見ても仕方がなく、
 * 実行中なら「予定を過ぎている」と数えてはいけない（長く走っているだけ）。
 */
export function evaluateTimer(timer: HostStatsTimer, now: number = Date.now()): TimerStatus {
    if (!timer.available) {
        return {
            timer,
            state: "unknown",
            abnormal: false,
            label: "取得できず",
            detail: "systemd へ問い合わせできず",
        }
    }

    if (timer.loaded === false) {
        return { timer, state: "missing", abnormal: true, label: "ユニットが無い" }
    }

    if (timer.active === false || timer.enabled === "masked") {
        return {
            timer,
            state: "stopped",
            abnormal: true,
            label: "タイマー停止",
            detail: timer.enabled ? `unit file: ${timer.enabled}` : undefined,
        }
    }

    if (timer.running) {
        return { timer, state: "running", abnormal: false, label: "実行中" }
    }

    if (timer.result && timer.result !== "success") {
        return {
            timer,
            state: "failed",
            abnormal: true,
            label: "失敗",
            detail:
                timer.exitStatus !== undefined
                    ? `${timer.result}（exit ${timer.exitStatus}）`
                    : timer.result,
        }
    }

    const nextElapse = toEpochMs(timer.nextElapseAt)
    if (nextElapse !== undefined) {
        const overdueSeconds = Math.floor((now - nextElapse) / 1000)
        if (overdueSeconds > getTimerGraceSeconds()) {
            return {
                timer,
                state: "overdue",
                abnormal: true,
                label: "未実行",
                detail: `予定より ${formatDelay(overdueSeconds)} 遅れ`,
            }
        }
    }

    return { timer, state: "ok", abnormal: false, label: "成功" }
}

export function evaluateTimers(
    timers: HostStatsTimer[] | undefined,
    now: number = Date.now()
): TimerStatus[] {
    return (timers ?? []).map((timer) => evaluateTimer(timer, now))
}

/**
 * 「失敗 exit-code（exit 1） · 実行 3時間前 · 次 20分後」のような、画面に出す1行。
 *
 * 現在時刻を読むのはこの関数の中だけにしている。React のコンポーネントの中で直接
 * `Date.now()` を呼ぶと純粋性の規則（react-hooks/purity）に触れるため。
 */
export function describeTimer(status: TimerStatus, now: number = Date.now()): string {
    const { timer } = status
    const lastRun = toEpochMs(timer.lastFinishedAt ?? timer.lastTriggerAt)
    const nextElapse = toEpochMs(timer.nextElapseAt)

    return [
        status.detail ? `${status.label} ${status.detail}` : status.label,
        lastRun === undefined ? "実行履歴なし" : `実行 ${formatAge(Math.round((now - lastRun) / 1000))}`,
        nextElapse === undefined ? null : `次 ${formatEta(Math.round((nextElapse - now) / 1000))}`,
    ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
}

export interface TimerSummary {
    /** 定期ジョブを送ってくるホストが1台でもあるか。無ければサマリーに出さない */
    available: boolean
    total: number
    /** 異常なユニットの「ホスト名: ユニット名」表記 */
    abnormalNames: string[]
    /** 状態を取得できなかったユニット数 */
    unknown: number
}

/**
 * 全ホストぶんの定期ジョブをまとめる。
 *
 * オフラインのホストは除く。最後に受け取ったスナップショットは古く、予定時刻を過ぎているのが
 * 当たり前になるため、ここで数えると OFFLINE 表示と二重に鳴ってしまう。
 */
export function summarizeTimers(hosts: HostStatsHostView[], now: number = Date.now()): TimerSummary {
    const summary: TimerSummary = { available: false, total: 0, abnormalNames: [], unknown: 0 }

    for (const host of hosts) {
        const timers = host.latest.timers
        if (!timers || timers.length === 0) continue

        summary.available = true
        if (!host.online) continue

        for (const status of evaluateTimers(timers, now)) {
            summary.total += 1
            if (status.state === "unknown") summary.unknown += 1
            if (status.abnormal) summary.abnormalNames.push(`${host.label}: ${status.timer.name}`)
        }
    }

    return summary
}
