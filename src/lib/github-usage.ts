import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream"
import type {
    GitHubActionsRepoUsage,
    GitHubActionsUsage,
    GitHubRateLimit,
    GitHubUsageSnapshot,
} from "@/types/github-usage"

const API_BASE = "https://api.github.com"

/** Freeプランに含まれるActionsの実行時間（分/月）。private リポジトリの分だけがここを消費する */
const DEFAULT_ALLOWANCE_MINUTES = 2000

const DEFAULT_CACHE_SECONDS = 300

/**
 * 取得に失敗したスナップショットは通常より短くしか持たない。
 * 一時的な失敗を通常のキャッシュ期間ぶん抱えると、復旧しているのに
 * エラー表示が数分間残り続けてしまうため。
 */
const ERROR_CACHE_SECONDS = 30

/** private リポジトリ一覧の取得ページ数の上限（1ページ100件） */
const MAX_REPO_PAGES = 5

interface UsageItem {
    product: string
    sku: string
    unitType: string
    quantity: number
    netAmount: number
    repositoryName?: string | null
}

interface UsageReportResponse {
    usageItems?: UsageItem[] | null
}

interface OrgRepository {
    name: string
}

interface RateLimitResponse {
    resources?: {
        core?: { limit?: number; remaining?: number; used?: number; reset?: number } | null
    } | null
}

/**
 * 実行環境ごとの無料枠の消費倍率（Windows は2倍、macOS は10倍で消費される）。
 * 課金レポートの quantity は実時間の分数で返るため、無料枠の消費量はここで倍率をかけて求める。
 */
function getRunnerMultiplier(sku: string): number {
    const normalized = sku.toLowerCase()
    if (normalized.includes("windows")) return 2
    if (normalized.includes("macos")) return 10
    return 1
}

async function githubFetch<T>(path: string, token: string): Promise<T> {
    let res: Response
    try {
        res = await fetchWithTimeout(`${API_BASE}${path}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        })
    } catch (error) {
        // どのエンドポイントで失敗したのかが画面から分かるように、経路名を添えて投げ直す
        throw new Error(`GET ${path} に到達できませんでした: ${describeError(error)}`)
    }

    if (!res.ok) {
        throw new Error(`GET ${path} が失敗しました (${res.status}): ${await readErrorBody(res)}`)
    }

    return (await res.json()) as T
}

/**
 * 無料枠を消費するのは private リポジトリのみのため、判定用に名前の集合を作る。
 * 課金レポート側は public/private を返さないので、別途この一覧と突き合わせる必要がある。
 */
async function fetchPrivateRepositoryNames(org: string, token: string): Promise<Set<string>> {
    const names = new Set<string>()

    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const repos = await githubFetch<OrgRepository[]>(
            `/orgs/${encodeURIComponent(org)}/repos?type=private&per_page=100&page=${page}`,
            token
        )

        for (const repo of repos) names.add(repo.name)
        if (repos.length < 100) break
    }

    return names
}

function startOfMonthUtc(base: Date): Date {
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1))
}

function startOfNextMonthUtc(base: Date): Date {
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1))
}

function roundTo(value: number, digits: number): number {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}

function getAllowanceLimitMinutes(): number {
    const configured = Number.parseInt(process.env.GH_ACTIONS_MINUTES_LIMIT ?? "", 10)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ALLOWANCE_MINUTES
}

/**
 * 今月のActions使用状況を課金レポートから組み立てる。
 *
 * 年月を明示せずに叩くと、全リポジトリの合計が単一のリポジトリ名に束ねられた状態で返るため、
 * リポジトリ別の内訳を出すには必ず year / month を指定する必要がある。
 */
async function fetchActionsUsage(org: string, token: string, now: Date): Promise<GitHubActionsUsage> {
    const year = now.getUTCFullYear()
    const month = now.getUTCMonth() + 1

    const [report, privateNames] = await Promise.all([
        githubFetch<UsageReportResponse>(
            `/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${year}&month=${month}`,
            token
        ),
        fetchPrivateRepositoryNames(org, token),
    ])

    const items = (report.usageItems ?? []).filter((item) => item.product === "actions")

    const minutesByRepo = new Map<string, { minutes: number; allowanceMinutes: number }>()
    let totalMinutes = 0
    let allowanceMinutes = 0
    let storageGigabyteHours = 0
    let netAmountUsd = 0

    for (const item of items) {
        netAmountUsd += item.netAmount

        if (item.unitType === "GigabyteHours") {
            storageGigabyteHours += item.quantity
            continue
        }

        if (item.unitType !== "Minutes") continue

        const repoName = item.repositoryName ?? "(不明)"
        const isPrivate = privateNames.has(repoName)
        const consumed = isPrivate ? item.quantity * getRunnerMultiplier(item.sku) : 0

        totalMinutes += item.quantity
        allowanceMinutes += consumed

        const current = minutesByRepo.get(repoName) ?? { minutes: 0, allowanceMinutes: 0 }
        minutesByRepo.set(repoName, {
            minutes: current.minutes + item.quantity,
            allowanceMinutes: current.allowanceMinutes + consumed,
        })
    }

    const repositories: GitHubActionsRepoUsage[] = [...minutesByRepo.entries()]
        .map(([name, value]) => ({
            name,
            minutes: Math.round(value.minutes),
            isPrivate: privateNames.has(name),
        }))
        .sort((a, b) => b.minutes - a.minutes)

    return {
        allowanceMinutes: Math.round(allowanceMinutes),
        allowanceLimitMinutes: getAllowanceLimitMinutes(),
        totalMinutes: Math.round(totalMinutes),
        storageGigabyteHours: roundTo(storageGigabyteHours, 2),
        netAmountUsd: roundTo(netAmountUsd, 2),
        repositories,
        periodStartsAt: startOfMonthUtc(now).toISOString(),
        resetsAt: startOfNextMonthUtc(now).toISOString(),
    }
}

async function fetchRateLimit(token: string): Promise<GitHubRateLimit> {
    const data = await githubFetch<RateLimitResponse>("/rate_limit", token)
    const core = data.resources?.core

    if (!core || typeof core.limit !== "number" || typeof core.remaining !== "number") {
        throw new Error("レート制限のレスポンスに core の情報がありません")
    }

    return {
        limit: core.limit,
        remaining: core.remaining,
        used: core.used ?? core.limit - core.remaining,
        resetsAt: new Date((core.reset ?? 0) * 1000).toISOString(),
    }
}

/**
 * 課金レポートはリポジトリ数ぶんのリクエストが必要になるうえ、
 * 実行時間は数分単位でしか動かないため、プロセス内でスナップショットをキャッシュする。
 */
let cache: { snapshot: GitHubUsageSnapshot; expiresAt: number } | null = null

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.GH_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

export async function getGitHubUsageSnapshot(): Promise<GitHubUsageSnapshot> {
    if (cache && cache.expiresAt > Date.now()) {
        return cache.snapshot
    }

    const token = process.env.GH_USAGE_TOKEN
    const org = process.env.GH_USAGE_ORG

    const snapshot = await buildSnapshot(token, org)
    const ttlMs = snapshot.status === "ok" ? getCacheTtlMs() : ERROR_CACHE_SECONDS * 1000
    cache = { snapshot, expiresAt: Date.now() + ttlMs }
    return snapshot
}

async function buildSnapshot(
    token: string | undefined,
    org: string | undefined
): Promise<GitHubUsageSnapshot> {
    const fetchedAt = new Date()

    if (!token || !org) {
        return {
            status: "unconfigured",
            message: "GH_USAGE_TOKEN と GH_USAGE_ORG が未設定です",
            org: org ?? null,
            actions: null,
            rateLimit: null,
            fetchedAt: fetchedAt.toISOString(),
        }
    }

    try {
        const [actions, rateLimit] = await Promise.all([
            fetchActionsUsage(org, token, fetchedAt),
            fetchRateLimit(token),
        ])

        return {
            status: "ok",
            org,
            actions,
            rateLimit,
            fetchedAt: fetchedAt.toISOString(),
        }
    } catch (error) {
        return {
            status: "error",
            message: describeError(error),
            org,
            actions: null,
            rateLimit: null,
            fetchedAt: fetchedAt.toISOString(),
        }
    }
}
