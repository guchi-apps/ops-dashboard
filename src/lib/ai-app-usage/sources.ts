import { promises as fs } from "node:fs"
import path from "node:path"

/** 使用量を読みにいく連携先の一覧（#325）。 */
export interface AiAppUsageSource {
    app: string
    url: string
}

export interface ParsedSources {
    sources: AiAppUsageSource[]
    /** 設定が壊れているときの理由（ログ用）。未設定・正常なら null */
    error: string | null
}

export class AiAppUsageSourcesError extends Error {}

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

export function parseSourceValues(data: unknown): ParsedSources {
    if (!Array.isArray(data)) return { sources: [], error: "連携先は配列で指定してください" }

    const sources: AiAppUsageSource[] = []
    const seen = new Set<string>()
    for (const value of data) {
        const entry = (value && typeof value === "object" ? value : {}) as { app?: unknown; url?: unknown }
        const app = typeof entry.app === "string" ? entry.app.trim() : ""
        const url = typeof entry.url === "string" ? entry.url.trim() : ""

        if (!app || !isAllowedUrl(url)) {
            return {
                sources: [],
                error: "各連携先には app と、https（またはループバックのhttp）の url が要ります",
            }
        }
        if (seen.has(app)) return { sources: [], error: `${app} が重複しています` }

        seen.add(app)
        sources.push({ app, url })
    }

    return { sources, error: null }
}

/** 旧環境変数を読む互換用。新しい設定は {@link getAiAppUsageSources} から読む。 */
export function parseSources(raw: string | undefined): ParsedSources {
    const text = raw?.trim()
    if (!text) return { sources: [], error: null }

    let data: unknown
    try {
        data = JSON.parse(text)
    } catch {
        return { sources: [], error: "AI_APP_USAGE_SOURCES がJSONとして読めません" }
    }
    return parseSourceValues(data)
}

function getSourcesPath(): string {
    return process.env.AI_APP_USAGE_SOURCES_PATH || path.join(process.cwd(), ".data", "ai-app-usage-sources.json")
}

async function writeSources(sources: AiAppUsageSource[]): Promise<void> {
    const file = getSourcesPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`)
    await fs.rename(temporary, file)
}

/** 画面とエージェントが同時に保存しても、あとに受け付けた置換を失わないよう直列化する。 */
let writeQueue: Promise<unknown> = Promise.resolve()

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task, task)
    writeQueue = run.catch(() => undefined)
    return run
}

/**
 * 連携先設定を読む。初回だけ旧環境変数から永続ファイルへ移すため、デプロイ後も既存設定を失わない。
 */
export async function getAiAppUsageSources(): Promise<ParsedSources> {
    try {
        const raw = await fs.readFile(getSourcesPath(), "utf8")
        const text = raw.trim()
        if (!text) return { sources: [], error: "連携先の設定ファイルが空です" }

        let data: unknown
        try {
            data = JSON.parse(text)
        } catch {
            return { sources: [], error: "連携先の設定ファイルがJSONとして読めません" }
        }
        return parseSourceValues(data)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return { sources: [], error: "連携先の設定ファイルを読めません" }
        }

        const legacy = parseSources(process.env.AI_APP_USAGE_SOURCES)
        if (legacy.error) return legacy
        try {
            await writeSources(legacy.sources)
        } catch {
            return { sources: [], error: "連携先の設定ファイルを作成できません" }
        }
        return legacy
    }
}

/** 画面と設定APIが同じ検証を通して一覧を置き換える。 */
export async function saveAiAppUsageSources(value: unknown): Promise<AiAppUsageSource[]> {
    const parsed = parseSourceValues(value)
    if (parsed.error) throw new AiAppUsageSourcesError(parsed.error)

    return serializeWrite(async () => {
        try {
            await writeSources(parsed.sources)
        } catch {
            throw new AiAppUsageSourcesError("連携先の設定を保存できません")
        }
        return parsed.sources
    })
}
