import { trackRepositoryVisibility } from "@/lib/github-repo-visibility"
import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream"
import {
    isUsageCacheFresh,
    newUsageCacheEntry,
    type UsageCacheEntry,
    type UsageFetchOptions,
} from "@/lib/usage-cache"
import type {
    GitHubActionsRepoUsage,
    GitHubActionsUsage,
    GitHubRateLimit,
    GitHubUsageSnapshot,
} from "@/types/github-usage"

const API_BASE = "https://api.github.com"

/**
 * プランごとに含まれるActionsの実行時間（分/月）。private リポジトリの分だけがここを消費する。
 * キーは `GET /orgs/{org}` の `plan.name`（小文字）で、`business` / `business_plus` は
 * Enterprise Cloud の旧称。無料枠の残量を直接返すAPIが無いため、プラン名から引く。
 */
const PLAN_ALLOWANCE_MINUTES: Record<string, number> = {
    free: 2000,
    team: 3000,
    business: 50000,
    business_plus: 50000,
    enterprise: 50000,
}

/**
 * プランを判別できなかったときに使う既定値（Freeプラン相当）。
 * `plan` は組織のオーナー権限を持つトークンでしか返らないため、権限が足りない場合はここに落ちる。
 */
const FALLBACK_ALLOWANCE_MINUTES = 2000

const DEFAULT_CACHE_SECONDS = 300

/**
 * 取得に失敗したスナップショットは通常より短くしか持たない。
 * 一時的な失敗を通常のキャッシュ期間ぶん抱えると、復旧しているのに
 * エラー表示が数分間残り続けてしまうため。
 */
const ERROR_CACHE_SECONDS = 30

/** リポジトリ一覧の取得ページ数の上限（1ページ100件） */
const MAX_REPO_PAGES = 5

interface UsageItem {
    /** 使用が発生した時刻（ISO 8601）。公開/非公開をその時点の状態で判定するのに使う */
    date: string
    product: string
    sku: string
    unitType: string
    quantity: number
    grossAmount: number
    discountAmount: number
    netAmount: number
    repositoryName?: string | null
}

interface UsageReportResponse {
    usageItems?: UsageItem[] | null
}

interface OrgRepository {
    name: string
    private: boolean
}

interface OrgResponse {
    plan?: { name?: string | null } | null
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

/**
 * `label` は失敗時に画面へ出す表示名。パスをそのまま出すと、組織名の設定を
 * 誤ってトークンを入れてしまった場合にそれが画面へ露出するため、パスは含めない。
 */
async function githubFetch<T>(path: string, token: string, label: string): Promise<T> {
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
        throw new Error(`${label}に到達できませんでした: ${describeError(error)}`)
    }

    if (!res.ok) {
        throw new Error(`${label}の取得に失敗しました (${res.status}): ${await readErrorBody(res)}`)
    }

    return (await res.json()) as T
}

/**
 * 組織のリポジトリと、その現在の公開状態を集める。
 * 課金レポート側は public/private を返さないので、別途この一覧と突き合わせる必要がある。
 *
 * 非公開のものだけでなく全件を取るのは、公開状態の履歴（{@link trackRepositoryVisibility}）に
 * 「いつ公開になったか」を残すため。公開のリポジトリを記録しないと切り替えを検出できない。
 */
async function fetchRepositoryVisibility(org: string, token: string): Promise<Map<string, boolean>> {
    const visibility = new Map<string, boolean>()

    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const repos = await githubFetch<OrgRepository[]>(
            `/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${page}`,
            token,
            "リポジトリ一覧"
        )

        for (const repo of repos) visibility.set(repo.name, repo.private)
        if (repos.length < 100) break
    }

    return visibility
}

/**
 * 無料枠の上限を引くための組織のプラン名を取得する。
 *
 * 上限はゲージの分母でしかなく、ここで落ちてGitHubセクション全体をエラーにするのは割に合わないため、
 * 失敗しても例外にせず null を返す（呼び出し側が既定値へ落とす）。
 */
async function fetchOrgPlanName(org: string, token: string): Promise<string | null> {
    try {
        const data = await githubFetch<OrgResponse>(
            `/orgs/${encodeURIComponent(org)}`,
            token,
            "組織情報"
        )
        return data.plan?.name?.toLowerCase() ?? null
    } catch (error) {
        console.warn("GitHub usage: 組織のプラン取得に失敗", describeError(error))
        return null
    }
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

/**
 * 無料枠の上限（分/月）を決める。優先順は 環境変数 > プラン名からの対応表 > 既定値。
 * プラン名が対応表に無い（新プラン・権限不足で取得できない）場合は既定値へ落ちるため、
 * そのときだけ環境変数で明示的に上書きすればよい。
 */
function getAllowanceLimitMinutes(planName: string | null): number {
    const configured = Number.parseInt(process.env.GH_ACTIONS_MINUTES_LIMIT ?? "", 10)
    if (Number.isFinite(configured) && configured > 0) return configured

    const byPlan = planName ? PLAN_ALLOWANCE_MINUTES[planName] : undefined
    if (byPlan) return byPlan

    console.warn(
        `GitHub usage: プラン「${planName ?? "不明"}」に対応する無料枠が分からないため ` +
            `${FALLBACK_ALLOWANCE_MINUTES}分を使います（GH_ACTIONS_MINUTES_LIMIT で上書きできます）`
    )
    return FALLBACK_ALLOWANCE_MINUTES
}

/** 課金明細から積み上げた、その月のActions全体の合計 */
interface ActionsTotals {
    minutes: number
    storageGigabyteHours: number
    grossAmountUsd: number
    discountAmountUsd: number
    netAmountUsd: number
}

/**
 * 今月のActions使用状況を課金レポートから組み立てる。
 *
 * 年月を明示せずに叩くと、全リポジトリの合計が単一のリポジトリ名に束ねられた状態で返るため、
 * リポジトリ別の内訳を出すには必ず year / month を指定する必要がある。
 *
 * 無料枠を消費するのは非公開リポジトリの分だけだが、課金レポートは公開/非公開を返さない。
 * 現在の公開状態だけで判定すると月の途中で公開へ切り替えたリポジトリの分が抜けるため、
 * {@link trackRepositoryVisibility} が持つ履歴を使って「使用時点の状態」で判定する（#151）。
 */
async function fetchActionsUsage(org: string, token: string, now: Date): Promise<GitHubActionsUsage> {
    const year = now.getUTCFullYear()
    const month = now.getUTCMonth() + 1

    const [report, repoVisibility, planName] = await Promise.all([
        githubFetch<UsageReportResponse>(
            `/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${year}&month=${month}`,
            token,
            "課金レポート"
        ),
        fetchRepositoryVisibility(org, token),
        fetchOrgPlanName(org, token),
    ])

    const visibility = await trackRepositoryVisibility(repoVisibility, now)
    const items = (report.usageItems ?? []).filter((item) => item.product === "actions")

    const minutesByRepo = new Map<string, { minutes: number; allowanceMinutes: number }>()
    let allowanceMinutes = 0
    const totals: ActionsTotals = {
        minutes: 0,
        storageGigabyteHours: 0,
        grossAmountUsd: 0,
        discountAmountUsd: 0,
        netAmountUsd: 0,
    }

    for (const item of items) {
        totals.grossAmountUsd += item.grossAmount
        totals.discountAmountUsd += item.discountAmount
        totals.netAmountUsd += item.netAmount

        if (item.unitType === "GigabyteHours") {
            totals.storageGigabyteHours += item.quantity
            continue
        }

        if (item.unitType !== "Minutes") continue

        const repoName = item.repositoryName ?? "(不明)"
        const wasPrivate = visibility.wasPrivateAt(repoName, new Date(item.date))
        const consumed = wasPrivate ? item.quantity * getRunnerMultiplier(item.sku) : 0

        totals.minutes += item.quantity
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
            isPrivate: visibility.isPrivateNow(name),
            allowanceMinutes: Math.round(value.allowanceMinutes),
        }))
        .sort((a, b) => b.minutes - a.minutes)

    return {
        allowanceMinutes: Math.round(allowanceMinutes),
        allowanceLimitMinutes: getAllowanceLimitMinutes(planName),
        totalMinutes: Math.round(totals.minutes),
        storageGigabyteHours: roundTo(totals.storageGigabyteHours, 2),
        grossAmountUsd: roundTo(totals.grossAmountUsd, 2),
        discountAmountUsd: roundTo(totals.discountAmountUsd, 2),
        netAmountUsd: roundTo(totals.netAmountUsd, 2),
        repositories,
        periodStartsAt: startOfMonthUtc(now).toISOString(),
        resetsAt: startOfNextMonthUtc(now).toISOString(),
    }
}

async function fetchRateLimit(token: string): Promise<GitHubRateLimit> {
    const data = await githubFetch<RateLimitResponse>("/rate_limit", token, "APIレート制限")
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
let cache: UsageCacheEntry<GitHubUsageSnapshot> | null = null

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.GH_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

export async function getGitHubUsageSnapshot({
    force = false,
}: UsageFetchOptions = {}): Promise<GitHubUsageSnapshot> {
    const cached = cache
    if (cached && isUsageCacheFresh(cached, force)) {
        return cached.snapshot
    }

    const token = process.env.GH_USAGE_TOKEN
    const org = process.env.GH_USAGE_ORG

    const snapshot = await buildSnapshot(token, org)
    const ttlMs = snapshot.status === "ok" ? getCacheTtlMs() : ERROR_CACHE_SECONDS * 1000
    cache = newUsageCacheEntry(snapshot, ttlMs)
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
