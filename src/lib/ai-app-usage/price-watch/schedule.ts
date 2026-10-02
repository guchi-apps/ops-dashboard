/**
 * 単価チェックの実行時刻（#497）。純粋関数。
 * 既定は毎週月曜05:00（Asia/Tokyo）。環境変数で曜日・時・タイムゾーンを変えられる。
 */

export interface WatchSchedule {
    /** 0=日曜 … 6=土曜 */
    day: number
    hour: number
    timeZone: string
}

export const DEFAULT_SCHEDULE: WatchSchedule = { day: 1, hour: 5, timeZone: "Asia/Tokyo" }

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"]

function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone })
        return true
    } catch {
        return false
    }
}

/** 環境変数から設定を読む。不正な値は既定へ戻す（設定の書き間違いでチェックが止まらないように） */
export function readSchedule(env: Record<string, string | undefined> = process.env): WatchSchedule {
    const day = Number(env.MODEL_PRICE_WATCH_DAY ?? "")
    const hour = Number(env.MODEL_PRICE_WATCH_HOUR ?? "")
    const timeZone = env.MODEL_PRICE_WATCH_TZ?.trim() ?? ""

    return {
        day: env.MODEL_PRICE_WATCH_DAY?.trim() && Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_SCHEDULE.day,
        hour: env.MODEL_PRICE_WATCH_HOUR?.trim() && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SCHEDULE.hour,
        timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_SCHEDULE.timeZone,
    }
}

export function describeSchedule(schedule: WatchSchedule): string {
    return `毎週${DAY_NAMES[schedule.day]}曜 ${String(schedule.hour).padStart(2, "0")}:00（${schedule.timeZone}）`
}

/** そのタイムゾーンでの、ある時刻のUTCとの差（ミリ秒） */
function offsetMs(at: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).formatToParts(new Date(at))
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
    return asUtc - Math.floor(at / 1000) * 1000
}

/** タイムゾーン上の年月日・時を、UTCのミリ秒へ（夏時間の境目は2回求めて補正する） */
function zonedToEpoch(year: number, month: number, day: number, hour: number, timeZone: string): number {
    const guess = Date.UTC(year, month - 1, day, hour)
    const first = guess - offsetMs(guess, timeZone)
    return guess - offsetMs(first, timeZone)
}

function localDate(at: number, timeZone: string): { year: number; month: number; day: number } {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(at))
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
    return { year: get("year"), month: get("month"), day: get("day") }
}

/** `now` 以前でいちばん新しい実行予定時刻（UTCのミリ秒）。毎週の設定なので、7日さかのぼれば必ず見つかる */
export function latestSlot(now: number, schedule: WatchSchedule): number {
    for (let back = 0; back <= 8; back++) {
        const { year, month, day } = localDate(now - back * 86_400_000, schedule.timeZone)
        if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== schedule.day) continue
        const slot = zonedToEpoch(year, month, day, schedule.hour, schedule.timeZone)
        if (slot <= now) return slot
    }
    return now
}

/** `now` より後でいちばん早い実行予定時刻 */
export function nextSlot(now: number, schedule: WatchSchedule): number {
    for (let ahead = 0; ahead <= 8; ahead++) {
        const { year, month, day } = localDate(now + ahead * 86_400_000, schedule.timeZone)
        if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== schedule.day) continue
        const slot = zonedToEpoch(year, month, day, schedule.hour, schedule.timeZone)
        if (slot > now) return slot
    }
    return now
}
