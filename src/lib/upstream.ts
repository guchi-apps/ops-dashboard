/**
 * 外部サービスのAPIを叩くときの共通処理。
 * AI使用状況・GitHub使用状況のように、応答が遅れたり壊れたりしうる相手を扱う箇所で使う。
 */

const DEFAULT_TIMEOUT_MS = 10_000

/** 相手のAPIが応答しないときにダッシュボード全体を待たせないためのタイムアウト付き fetch */
export async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
    return fetch(url, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
    })
}

export function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

/** 例外の内容を画面に出せる長さへ縮める */
export function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/\s+/g, " ").trim().slice(0, 120)
}

export async function readErrorBody(res: Response): Promise<string> {
    try {
        const text = await res.text()
        return text.slice(0, 200)
    } catch {
        return ""
    }
}
