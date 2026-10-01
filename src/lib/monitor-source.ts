/** 監視モニターの表示名まわりの、クライアントからも読む定数と型（node:fs を読む monitor-names.ts とは分ける。#479） */

export type MonitorSource = "kuma" | "robot"

export const MAX_DISPLAY_NAME_LENGTH = 60

export function isMonitorSource(value: unknown): value is MonitorSource {
    return value === "kuma" || value === "robot"
}

/** 系統とIDから保存用のキーを作る。KumaとUptimeRobotのIDは別物なので系統を前に付ける */
export function monitorNameKey(source: MonitorSource, id: number): string {
    return `${source}:${id}`
}
