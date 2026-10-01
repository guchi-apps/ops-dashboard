// クライアントからも読むため、node:fs を読む uptimerobot.ts（表示名の適用。#479）とは分ける

export function getUptimeRobotStatusInfo(status: number): { text: string; color: string } {
    switch (status) {
        case 2:
            return { text: "Running", color: "text-status-ok" }
        case 8:
        case 9:
            return { text: "Down", color: "text-red-400" }
        case 0:
            return { text: "Paused", color: "text-yellow-400" }
        case 1:
            return { text: "Checking...", color: "text-primary" }
        default:
            return { text: "Unknown", color: "text-slate-400" }
    }
}
