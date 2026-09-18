import fs from "fs/promises"
import path from "path"
import { hasSubscriptions, isWebPushConfigured, sendPushToAll, type PushMessage } from "@/lib/push/web-push"
import { formatRemaining } from "@/lib/usage-format"
import type { AiProviderUsage, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/**
 * AI利用枠が上限に近づいたらプッシュ通知を送る（#263）。
 *
 * - Claudeの5時間枠が90%以上
 * - 週間枠（Claudeの全体・Opus・Sonnet、ChatGPT）が95%以上
 * - 上の枠が100%
 *
 * 判定は提供元から使用状況を取れた回ごとに走る（`getAiUsageSnapshot`）。ホストのエージェントが
 * メトリクスを送るたびに取得が回るため、画面を開いていなくても5分おきに判定される。
 * 同じ枠・同じ段階は1回だけ送り、送ったことを `.data/ai-usage-alerts.json` に残す。
 */

const FIVE_HOUR_SECONDS = 5 * 60 * 60
/** 週間枠とみなす長さの下限。ChatGPTは枠の長さを提供元が返すため、ぴったり7日とは限らない */
const WEEKLY_MIN_SECONDS = 6 * 24 * 60 * 60

const FIVE_HOUR_WARN_PERCENT = 90
const WEEKLY_WARN_PERCENT = 95
const FULL_PERCENT = 100

/**
 * 直前に記録した枠と同じ枠だとみなす、リセット時刻の進み幅（枠の長さに対する割合）。
 * ChatGPTはリセット時刻が取得のたびに数秒ずれるため、一致では同定しない（history.ts と同じ考え方）。
 */
const SAME_WINDOW_RATIO = 0.5

type AlertLevel = "warn" | "full"

const LEVEL_RANK: Record<AlertLevel, number> = { warn: 1, full: 2 }

interface StoredAlert {
    resetsAt: string
    level: AlertLevel
}

interface AlertState {
    /** 枠のキー → その枠で最後に送った段階 */
    windows: Record<string, StoredAlert>
}

export interface UsageAlert {
    key: string
    level: AlertLevel
    message: PushMessage
}

function getStatePath(): string {
    return (
        process.env.AI_USAGE_ALERTS_PATH ||
        path.join(process.cwd(), ".data", "ai-usage-alerts.json")
    )
}

async function readState(): Promise<AlertState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(), "utf8"))
        const windows = (parsed as AlertState | null)?.windows
        return { windows: windows && typeof windows === "object" ? windows : {} }
    } catch {
        return { windows: {} }
    }
}

async function writeState(state: AlertState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/** 通知の対象になる枠なら、その警告の閾値（%）を返す */
function getWarnPercent(provider: AiProviderUsage, usageWindow: AiUsageWindow): number | null {
    if (!usageWindow.windowSeconds) return null
    if (usageWindow.windowSeconds >= WEEKLY_MIN_SECONDS) return WEEKLY_WARN_PERCENT
    if (provider.id === "claude" && usageWindow.windowSeconds === FIVE_HOUR_SECONDS) {
        return FIVE_HOUR_WARN_PERCENT
    }
    return null
}

/** 同じ長さでもモデル別の枠（週間 / 週間Opus）は別物なので、補足込みで区別する */
function windowKey(provider: AiProviderUsage, usageWindow: AiUsageWindow): string {
    return `${provider.id}:${usageWindow.windowSeconds}:${usageWindow.note ?? ""}`
}

function isSameWindow(stored: StoredAlert, resetsAt: string, windowSeconds: number): boolean {
    const shiftMs = Math.abs(Date.parse(resetsAt) - Date.parse(stored.resetsAt))
    return !Number.isNaN(shiftMs) && shiftMs < windowSeconds * 1000 * SAME_WINDOW_RATIO
}

/** リセット時刻を日本時間で。今日なら時刻だけ、別の日なら日付も付ける */
function formatResetTime(resetsAt: string, now: number): string {
    const format = (date: Date, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...options }).format(date)

    const reset = new Date(resetsAt)
    const sameDay =
        format(reset, { year: "numeric", month: "numeric", day: "numeric" }) ===
        format(new Date(now), { year: "numeric", month: "numeric", day: "numeric" })
    const time = format(reset, { hour: "2-digit", minute: "2-digit", hour12: false })

    return sameDay ? time : `${format(reset, { month: "numeric", day: "numeric" })} ${time}`
}

function buildMessage(
    provider: AiProviderUsage,
    usageWindow: AiUsageWindow & { resetsAt: string },
    level: AlertLevel,
    warnPercent: number,
    key: string,
    now: number
): PushMessage {
    const name = `${provider.name} ${usageWindow.label}枠${usageWindow.note ? `（${usageWindow.note}）` : ""}`
    const title =
        level === "full" ? `${name}が上限に達しました` : `${name}が${warnPercent}%を超えました`

    const remaining = formatRemaining(usageWindow.resetsAt, now)
    const reset = remaining ? `${remaining}（${formatResetTime(usageWindow.resetsAt, now)}）` : null

    return {
        title,
        body: [`使用率 ${Math.round(usageWindow.usedPercent)}%`, reset].filter(Boolean).join("。"),
        tag: `ai-usage:${key}`,
        url: "/?tab=usage",
    }
}

/**
 * 今回のスナップショットで送るべき通知と、更新後の記録を求める。
 * 枠がリセットされていれば段階を忘れ、次の枠でまた送る。起動時点ですでに100%なら警告は飛ばす。
 */
export function evaluateUsageAlerts(
    snapshot: AiUsageSnapshot,
    state: AlertState,
    now: number
): { alerts: UsageAlert[]; state: AlertState } {
    const windows = { ...state.windows }
    const alerts: UsageAlert[] = []

    for (const provider of snapshot.providers) {
        // 取得に失敗した提供元は0%扱いになっているので判定しない
        if (provider.status !== "ok") continue

        for (const usageWindow of provider.windows) {
            const { resetsAt, windowSeconds } = usageWindow
            if (!resetsAt || !windowSeconds || Number.isNaN(Date.parse(resetsAt))) continue

            const warnPercent = getWarnPercent(provider, usageWindow)
            if (warnPercent === null) continue

            const key = windowKey(provider, usageWindow)
            const stored = windows[key]
            const sent = stored && isSameWindow(stored, resetsAt, windowSeconds) ? stored.level : null

            const level: AlertLevel | null =
                usageWindow.usedPercent >= FULL_PERCENT
                    ? "full"
                    : usageWindow.usedPercent >= warnPercent
                      ? "warn"
                      : null
            if (!level || (sent && LEVEL_RANK[sent] >= LEVEL_RANK[level])) continue

            windows[key] = { resetsAt, level }
            alerts.push({
                key,
                level,
                message: buildMessage(provider, { ...usageWindow, resetsAt }, level, warnPercent, key, now),
            })
        }
    }

    return { alerts, state: { windows } }
}

let running: Promise<void> = Promise.resolve()

/**
 * 判定して、送るべきものがあれば登録済みの全端末へ送る。
 * 鍵が無い・登録した端末が無いときは記録もしない（あとで登録した端末へ、いまの状態を送れるように）。
 */
export function notifyUsageAlerts(snapshot: AiUsageSnapshot): Promise<void> {
    const run = running.then(async () => {
        if (!isWebPushConfigured() || !(await hasSubscriptions())) return

        const { alerts, state } = evaluateUsageAlerts(snapshot, await readState(), Date.now())
        if (alerts.length === 0) return

        // 先に記録してから送る。送信中に次の判定が走っても同じ通知を二重に送らないため
        await writeState(state)
        for (const alert of alerts) await sendPushToAll(alert.message)
    })
    running = run.catch(() => undefined)
    return run
}
