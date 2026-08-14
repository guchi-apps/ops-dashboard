export function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B"

    const units = ["B", "KB", "MB", "GB", "TB"]
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    const value = bytes / 1024 ** exponent

    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)

    if (days > 0) return `${days}d ${hours}h ${minutes}m`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
}

/** 「42秒前」「3時間前」のような経過時間の表示。最終受信・最終活動の両方で使う */
export function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}秒前`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`
    return `${Math.floor(seconds / 86400)}日前`
}

/**
 * 「1.1M/s」のような、幅の狭い場所向けの転送量。
 * 概要タブの指標タイルは1行に収める必要があり、「1.1 MB/s」だと折り返してしまう。
 */
export function formatRateShort(bytesPerSecond: number): string {
    const [value, unit] = formatBytes(bytesPerSecond).split(" ")
    return `${value}${unit === "B" ? "" : unit.charAt(0)}/s`
}
