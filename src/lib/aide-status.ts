import { fetchWithTimeout } from "@/lib/upstream"
import type {
    AideHealth,
    AideProbeResponse,
    AideProbeResult,
    AideStatusSnapshot,
} from "@/types/aide-status"

/**
 * AIDE（MCPサーバー）の動作状況の取得（#237）。
 *
 * 状態はAIDEのプロセス内の値（稼働時間・ジョブの記録・MCPアクセスの記録）から組み立てられて
 * いて、ファイルを読むだけでは揃わない。AIDE側の読み取りAPI（guchi-apps/aide#276）を叩く。
 * 両方とも同じVPS上のPM2プロセスなので localhost 経由で届く（AIDEが ops-dashboard を
 * 読むときと逆向きの同じ方式）。
 *
 * **トークンは `OPS_API_TOKEN` とは別にしている。** あちらはAIDEが ops-dashboard を読むための
 * もので、向きが逆。同じ値にすると、片方が漏れたときに両方向とも読めるようになる。
 */

/** AIDEは同じVPS上のPM2プロセス（ポート3114。guchi-apps/aide の deploy/ecosystem.config.cjs） */
const DEFAULT_BASE_URL = "http://127.0.0.1:3114"

/** AIDEは手元のファイルを読むだけで返すため、localhost なら数十ミリ秒で返る */
const STATUS_TIMEOUT_MS = 5_000

/**
 * 疎通確認はAIDEが各接続先へ問い合わせてから返る。AIDE側の1本あたりの制限（3秒）を
 * 並列に待つので、それより十分長く取る
 */
const CHECKS_TIMEOUT_MS = 20_000

/** 失敗したときに、何を確かめればよいかが分かるステータスだけ理由を添える */
const HTTP_HINTS: Record<number, string> = {
    401: "AIDE_STATUS_TOKEN がAIDE側の値と一致していません",
    404: "AIDEに動作状況のAPIがありません（guchi-apps/aide#276）",
    503: "AIDE側で AIDE_STATUS_SECRET が未設定です",
}

interface AideConfig {
    baseUrl: string
    token: string
}

/** トークンは認証情報として扱う。戻り値をログ・レスポンスへ出さないこと */
function readAideConfig(): AideConfig | null {
    const token = process.env.AIDE_STATUS_TOKEN
    if (!token) return null

    const baseUrl = process.env.AIDE_BASE_URL || DEFAULT_BASE_URL
    return { baseUrl: baseUrl.replace(/\/+$/, ""), token }
}

/** 未設定の環境（worktree・開発機）ではタブごと出さない。ページ側で判定に使う */
export function isAideStatusConfigured(): boolean {
    return readAideConfig() !== null
}

class AideHttpError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`)
        this.name = "AideHttpError"
    }
}

/**
 * 失敗の理由を画面に出してよい粒度まで丸める。
 * 例外の message には接続先のURLが載ることがあるため、HTTPステータスと種別だけにする
 */
function describeFailure(error: unknown, timeoutMs: number): string {
    if (error instanceof AideHttpError) {
        const hint = HTTP_HINTS[error.status]
        return hint ? `HTTP ${error.status}（${hint}）` : `HTTP ${error.status}`
    }
    if (error instanceof Error) {
        if (error.name === "TimeoutError") return `${timeoutMs}ms 以内に応答しませんでした`
        if (error.name === "SyntaxError") return "想定と違う形の応答が返りました"
    }
    return "AIDEに接続できませんでした"
}

async function requestAide(
    config: AideConfig,
    path: string,
    method: "GET" | "POST",
    timeoutMs: number
): Promise<unknown> {
    const res = await fetchWithTimeout(
        `${config.baseUrl}${path}`,
        {
            method,
            headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        },
        timeoutMs
    )
    if (!res.ok) throw new AideHttpError(res.status)
    return res.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/** 描画が前提にする骨格だけを確かめる。AIDE側の形が変わったときに画面ごと落ちないようにする */
function isStatusPayload(payload: unknown): payload is { health: AideHealth; tools: string[] } {
    if (!isRecord(payload) || !isRecord(payload.health)) return false
    const health = payload.health
    return (
        typeof health.severity === "string" &&
        Array.isArray(health.attention) &&
        Array.isArray(health.jobs) &&
        Array.isArray(health.connectors) &&
        isRecord(health.server) &&
        isRecord(health.cache) &&
        isRecord(health.mcp) &&
        isRecord(health.mcpAccess) &&
        Array.isArray(payload.tools)
    )
}

/**
 * 直前に取得できた値。取得に失敗したときも画面にはこれを残す。
 * プロセス内に持つだけなので、再起動した直後に失敗すると何も出せない（それで困る情報ではない）
 */
let lastGood: { health: AideHealth; tools: string[]; fetchedAt: string } | null = null

export async function getAideStatusSnapshot(): Promise<AideStatusSnapshot> {
    const fetchedAt = new Date().toISOString()
    const config = readAideConfig()
    if (!config) {
        return {
            status: "unconfigured",
            message: "AIDE_STATUS_TOKEN が未設定です",
            health: null,
            tools: [],
            fetchedAt,
            healthFetchedAt: null,
        }
    }

    try {
        const payload = await requestAide(config, "/api/status", "GET", STATUS_TIMEOUT_MS)
        if (!isStatusPayload(payload)) throw new SyntaxError("unexpected payload")

        lastGood = { health: payload.health, tools: payload.tools, fetchedAt }
        return {
            status: "ok",
            health: payload.health,
            tools: payload.tools,
            fetchedAt,
            healthFetchedAt: fetchedAt,
        }
    } catch (error) {
        console.error("AIDE status error:", error)
        return {
            status: "error",
            message: describeFailure(error, STATUS_TIMEOUT_MS),
            health: lastGood?.health ?? null,
            tools: lastGood?.tools ?? [],
            fetchedAt,
            healthFetchedAt: lastGood?.fetchedAt ?? null,
        }
    }
}

/** 疎通確認。**押されたときだけ呼ぶ**（AIDEが外部サービスへ問い合わせるため） */
export async function runAideStatusChecks(): Promise<AideProbeResponse> {
    const config = readAideConfig()
    if (!config) {
        return { status: "unconfigured", message: "AIDE_STATUS_TOKEN が未設定です", results: [] }
    }

    try {
        const payload = await requestAide(config, "/api/status/checks", "POST", CHECKS_TIMEOUT_MS)
        if (!isRecord(payload) || !Array.isArray(payload.results)) {
            throw new SyntaxError("unexpected payload")
        }
        return { status: "ok", results: payload.results as AideProbeResult[] }
    } catch (error) {
        console.error("AIDE status checks error:", error)
        return { status: "error", message: describeFailure(error, CHECKS_TIMEOUT_MS), results: [] }
    }
}
