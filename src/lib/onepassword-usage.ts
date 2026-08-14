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
 * `reset` は時刻ではなくリセットまでの残り秒数で返る。
 * 枠の起点は最初のリクエストの時刻なので、まだ1回も使っていない枠では 0 になり、
 * その場合はリセット時刻が定まらないため null にする。
 */
function toResetIso(value: unknown, fetchedAtMs: number): string | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
    return new Date(fetchedAtMs + value * 1000).toISOString()
}

function toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function parseRateLimits(stdout: string, fetchedAtMs: number): OnePasswordRateLimit[] {
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
                remaining: toCount(item.remaining),
                resetsAt: toResetIso(item.reset, fetchedAtMs),
            }
        })
}

async function fetchRateLimits(token: string, fetchedAtMs: number): Promise<OnePasswordRateLimit[]> {
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

    return parseRateLimits(stdout, fetchedAtMs)
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
    const fetchedAtMs = Date.now()
    const fetchedAt = new Date(fetchedAtMs).toISOString()

    if (!token) {
        return {
            status: "unconfigured",
            message: "OP_SERVICE_ACCOUNT_TOKEN が未設定です",
            limits: [],
            fetchedAt,
        }
    }

    try {
        return { status: "ok", limits: await fetchRateLimits(token, fetchedAtMs), fetchedAt }
    } catch (error) {
        return { status: "error", message: describeError(error), limits: [], fetchedAt }
    }
}
