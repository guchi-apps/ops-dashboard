import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describeError } from "@/lib/upstream"
import type {
    OnePasswordLimitAction,
    OnePasswordLimitType,
    OnePasswordRateLimit,
    OnePasswordUsageSnapshot,
} from "@/types/onepassword-usage"

const execFileAsync = promisify(execFile)

const DEFAULT_CACHE_SECONDS = 300

/** 取得に失敗したスナップショットは短くしか持たない（復旧後もエラー表示が残り続けるのを避ける） */
const ERROR_CACHE_SECONDS = 30

const COMMAND_TIMEOUT_MS = 10_000

/** サービスアカウントの枠は他サービスのようなHTTP APIが無く、CLI経由でしか取得できない */
const DEFAULT_CLI_PATH = "op"

interface RateLimitItem {
    type?: unknown
    action?: unknown
    limit?: unknown
    used?: unknown
    remaining?: unknown
    reset?: unknown
}

/**
 * `reset` の型はCLIの出力仕様として文書化されていないため、
 * エポック秒・ミリ秒・ISO文字列のいずれで返ってきても読めるようにしておく。
 * 一度も枠を使っておらず起点が無い場合はゼロ値が入るので、その場合は null にする。
 */
function toResetIso(value: unknown): string | null {
    if (typeof value === "number" && value > 0) {
        const ms = value > 1e11 ? value : value * 1000
        return new Date(ms).toISOString()
    }

    if (typeof value === "string") {
        const ms = Date.parse(value)
        if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
    }

    return null
}

function toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function parseRateLimits(stdout: string): OnePasswordRateLimit[] {
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("レート制限の応答が配列ではありません")

    return (parsed as RateLimitItem[])
        .filter((item) => item.type === "token" || item.type === "account")
        .map((item) => {
            const limit = toCount(item.limit)
            const used = toCount(item.used)

            return {
                type: item.type as OnePasswordLimitType,
                action: String(item.action) as OnePasswordLimitAction,
                limit,
                used,
                remaining: toCount(item.remaining) || Math.max(0, limit - used),
                resetsAt: toResetIso(item.reset),
            }
        })
}

async function fetchRateLimits(token: string): Promise<OnePasswordRateLimit[]> {
    // 環境をそのまま渡すと他サービスの認証情報まで子プロセスに配ることになるため、必要な分だけ渡す
    const { stdout } = await execFileAsync(
        process.env.OP_CLI_PATH ?? DEFAULT_CLI_PATH,
        ["service-account", "ratelimit", "--format=json"],
        {
            timeout: COMMAND_TIMEOUT_MS,
            env: {
                NODE_ENV: process.env.NODE_ENV,
                OP_SERVICE_ACCOUNT_TOKEN: token,
                PATH: process.env.PATH ?? "",
                HOME: process.env.HOME ?? "",
            },
        }
    )

    return parseRateLimits(stdout)
}

let cache: { snapshot: OnePasswordUsageSnapshot; expiresAt: number } | null = null

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.OP_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

export async function getOnePasswordUsageSnapshot(): Promise<OnePasswordUsageSnapshot> {
    if (cache && cache.expiresAt > Date.now()) {
        return cache.snapshot
    }

    const snapshot = await buildSnapshot(process.env.OP_SERVICE_ACCOUNT_TOKEN)
    const ttlMs = snapshot.status === "ok" ? getCacheTtlMs() : ERROR_CACHE_SECONDS * 1000
    cache = { snapshot, expiresAt: Date.now() + ttlMs }
    return snapshot
}

async function buildSnapshot(token: string | undefined): Promise<OnePasswordUsageSnapshot> {
    const fetchedAt = new Date().toISOString()

    if (!token) {
        return {
            status: "unconfigured",
            message: "OP_SERVICE_ACCOUNT_TOKEN が未設定です",
            limits: [],
            fetchedAt,
        }
    }

    try {
        return { status: "ok", limits: await fetchRateLimits(token), fetchedAt }
    } catch (error) {
        return { status: "error", message: describeError(error), limits: [], fetchedAt }
    }
}
