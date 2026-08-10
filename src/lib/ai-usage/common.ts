const DEFAULT_TIMEOUT_MS = 10_000

/** 提供元のAPIが応答しないときにダッシュボード全体を待たせないためのタイムアウト付き fetch */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
}

export function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

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

export async function readErrorBody(res: Response): Promise<string> {
    try {
        const text = await res.text()
        return text.slice(0, 200)
    } catch {
        return ""
    }
}
