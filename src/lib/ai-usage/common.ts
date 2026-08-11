/** 制限枠の長さ（秒）を "5時間" / "週間" のような表示名にする */
export function formatWindowLabel(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "制限枠"
    if (seconds === 604_800) return "週間"

    const hours = seconds / 3600
    if (hours < 24) {
        return `${Math.round(hours * 10) / 10}時間`
    }

    const days = Math.round(hours / 24)
    return `${days}日間`
}
