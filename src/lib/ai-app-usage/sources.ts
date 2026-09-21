/**
 * 使用量を読みにいく連携先の一覧（#325）。環境変数 `AI_APP_USAGE_SOURCES` に、
 * `[{"app":"aide-bot","url":"https://.../api/ai-usage"}]` のようなJSON配列で渡す。
 */
export interface AiAppUsageSource {
    app: string
    url: string
}

export interface ParsedSources {
    sources: AiAppUsageSource[]
    /** 設定が壊れているときの理由（ログ用）。未設定・正常なら null */
    error: string | null
}

/**
 * Bearerトークン（`OPS_API_TOKEN`）を平文で送らないよう、通信は https か、同じホスト内の
 * ループバックに限る。同一VPS上のアプリを `http://127.0.0.1:<ポート>` で読む構成を許すため。
 */
function isAllowedUrl(value: string): boolean {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }

    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
}

export function parseSources(raw: string | undefined): ParsedSources {
    const text = raw?.trim()
    if (!text) return { sources: [], error: null }

    let data: unknown
    try {
        data = JSON.parse(text)
    } catch {
        return { sources: [], error: "AI_APP_USAGE_SOURCES がJSONとして読めません" }
    }
    if (!Array.isArray(data)) return { sources: [], error: "AI_APP_USAGE_SOURCES は配列で指定してください" }

    const sources: AiAppUsageSource[] = []
    const seen = new Set<string>()
    for (const value of data) {
        const entry = (value && typeof value === "object" ? value : {}) as { app?: unknown; url?: unknown }
        const app = typeof entry.app === "string" ? entry.app.trim() : ""
        const url = typeof entry.url === "string" ? entry.url.trim() : ""

        if (!app || !isAllowedUrl(url)) {
            return {
                sources: [],
                error: "AI_APP_USAGE_SOURCES の各要素には app と、https（またはループバックのhttp）の url が要ります",
            }
        }
        if (seen.has(app)) return { sources: [], error: `AI_APP_USAGE_SOURCES に ${app} が重複しています` }

        seen.add(app)
        sources.push({ app, url })
    }

    return { sources, error: null }
}
