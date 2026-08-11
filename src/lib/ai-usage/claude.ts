import {
    clampPercent,
    describeError,
    fetchWithTimeout,
    readErrorBody,
} from "@/lib/upstream"
import { formatWindowLabel } from "@/lib/ai-usage/common"
import { getAccessToken, type RefreshResult } from "@/lib/ai-usage/token-store"
import type { AiProviderBilling, AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

/**
 * Claude Code の `/usage` が参照しているのと同じOAuthエンドポイントを叩く。
 * 公式に文書化されたAPIではないため、仕様変更で壊れうる前提で扱う。
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/** 契約プランは使用状況のレスポンスに含まれないため、プロフィールから取得する */
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

/** トークンエンドポイントは console.anthropic.com から platform.claude.com へ移行済み。念のため両方試す */
const TOKEN_URLS = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
]

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/** claude-code を名乗らないと極端に厳しいレート制限バケットに入り 429 が返り続ける */
const DEFAULT_USER_AGENT = "claude-code/2.0.14"

interface UsageWindowResponse {
    utilization?: number | null
    resets_at?: string | null
}

/** プラン枠を超えた分の課金額。`amount_minor` を `exponent` 桁の小数として扱う */
interface SpendAmount {
    amount_minor?: number | null
    currency?: string | null
    exponent?: number | null
}

interface OauthUsageResponse {
    five_hour?: UsageWindowResponse | null
    seven_day?: UsageWindowResponse | null
    seven_day_opus?: UsageWindowResponse | null
    seven_day_sonnet?: UsageWindowResponse | null
    spend?: {
        enabled?: boolean | null
        used?: SpendAmount | null
        limit?: SpendAmount | null
    } | null
}

interface ProfileResponse {
    account?: {
        has_claude_max?: boolean | null
        has_claude_pro?: boolean | null
    } | null
    organization?: {
        organization_type?: string | null
        /** 例: "default_claude_max_5x" */
        rate_limit_tier?: string | null
    } | null
}

interface TokenResponse {
    access_token?: string
    refresh_token?: string
    expires_in?: number
}

function userAgent(): string {
    return process.env.ANTHROPIC_CLIENT_USER_AGENT || DEFAULT_USER_AGENT
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
    let lastError = ""

    for (const url of TOKEN_URLS) {
        const res = await fetchWithTimeout(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": userAgent(),
            },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: OAUTH_CLIENT_ID,
            }),
        })

        if (res.status === 404) {
            lastError = `${url}: 404`
            continue
        }

        if (!res.ok) {
            throw new Error(`トークンの更新に失敗しました (${res.status}): ${await readErrorBody(res)}`)
        }

        const data = (await res.json()) as TokenResponse
        if (!data.access_token) {
            throw new Error("トークンの更新レスポンスに access_token がありません")
        }

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresInSeconds: data.expires_in,
        }
    }

    throw new Error(`トークンエンドポイントが見つかりません (${lastError})`)
}

/**
 * `claude setup-token` の長期トークン（sk-ant-oat01-...）は使えない。
 * 発行時に user:inference スコープしか要求されず、このエンドポイントが求める
 * user:profile が付かないため 403 になる。user:profile が付くのは
 * `claude login` のフルOAuthで発行されるトークンだけなので、そのリフレッシュトークンを使う。
 */
async function resolveAccessToken(): Promise<string | null> {
    const refreshToken = process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN
    if (!refreshToken) return null

    return getAccessToken("claude", refreshToken, refreshAccessToken)
}

const FIVE_HOUR_SECONDS = 5 * 60 * 60
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60

function toWindow(
    windowSeconds: number,
    source: UsageWindowResponse | null | undefined,
    note?: string
): AiUsageWindow | null {
    if (!source || typeof source.utilization !== "number") return null

    return {
        label: formatWindowLabel(windowSeconds),
        usedPercent: clampPercent(source.utilization),
        resetsAt: source.resets_at ?? null,
        windowSeconds,
        note,
    }
}

function formatAmount(amount: SpendAmount | null | undefined): string | null {
    if (!amount || typeof amount.amount_minor !== "number") return null

    const currency = amount.currency || "USD"
    const value = amount.amount_minor / 10 ** (amount.exponent ?? 2)

    try {
        return new Intl.NumberFormat("ja-JP", { style: "currency", currency }).format(value)
    } catch {
        return `${value} ${currency}`
    }
}

function toBilling(data: OauthUsageResponse): AiProviderBilling | undefined {
    if (!data.spend?.enabled) return undefined

    const amount = formatAmount(data.spend.used)
    if (!amount) return undefined

    return {
        label: "追加利用クレジット",
        amount,
        limit: formatAmount(data.spend.limit) ?? undefined,
    }
}

/** プロフィールのレスポンスからプランの表示名を組み立てる */
export function parseClaudePlan(profile: ProfileResponse): string | null {
    const tier = profile.organization?.rate_limit_tier ?? ""

    // "default_claude_max_5x" のように倍率が入っていればそれを表示に使う
    const maxTier = tier.match(/claude_max_(\d+)x/)
    if (maxTier) return `Max ${maxTier[1]}x`
    if (tier.includes("claude_max")) return "Max"
    if (tier.includes("claude_pro")) return "Pro"

    const orgType = profile.organization?.organization_type ?? ""
    if (orgType === "claude_max") return "Max"
    if (orgType === "claude_pro") return "Pro"

    if (profile.account?.has_claude_max) return "Max"
    if (profile.account?.has_claude_pro) return "Pro"

    return null
}

/** レスポンスから表示に使う制限枠と課金状況を取り出す */
export function parseClaudeUsageResponse(data: OauthUsageResponse): {
    windows: AiUsageWindow[]
    billing?: AiProviderBilling
} {
    const windows = [
        toWindow(FIVE_HOUR_SECONDS, data.five_hour),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day_opus, "Opus"),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day_sonnet, "Sonnet"),
    ].filter((window): window is AiUsageWindow => window !== null)

    return { windows, billing: toBilling(data) }
}

/** プランの取得に失敗しても使用状況の表示は続けたいので、失敗時は null を返す */
async function fetchPlan(accessToken: string): Promise<string | null> {
    try {
        const res = await fetchWithTimeout(PROFILE_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": userAgent(),
                Accept: "application/json",
            },
        })
        if (!res.ok) {
            console.error("Claude profile API error:", res.status, await readErrorBody(res))
            return null
        }

        return parseClaudePlan((await res.json()) as ProfileResponse)
    } catch (error) {
        console.error("Claude profile: 取得に失敗", error)
        return null
    }
}

export async function fetchClaudeUsage(): Promise<AiProviderUsage> {
    const base: Omit<AiProviderUsage, "status"> = {
        id: "claude",
        name: "Claude",
        plan: null,
        windows: [],
    }

    let accessToken: string | null
    try {
        accessToken = await resolveAccessToken()
    } catch (error) {
        console.error("Claude usage: トークン更新に失敗", error)
        return {
            ...base,
            status: "error",
            message: `認証トークンを更新できませんでした: ${describeError(error)}`,
        }
    }

    if (!accessToken) {
        return {
            ...base,
            status: "unconfigured",
            message: "ANTHROPIC_OAUTH_REFRESH_TOKEN が未設定です",
        }
    }

    try {
        const [res, detectedPlan] = await Promise.all([
            fetchWithTimeout(USAGE_URL, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "anthropic-beta": "oauth-2025-04-20",
                    "User-Agent": userAgent(),
                    Accept: "application/json",
                },
            }),
            fetchPlan(accessToken),
        ])

        // 環境変数を設定した場合はそちらを表示名として優先する
        base.plan = process.env.CLAUDE_PLAN_NAME || detectedPlan

        if (!res.ok) {
            console.error("Claude usage API error:", res.status, await readErrorBody(res))
            return {
                ...base,
                status: "error",
                message:
                    res.status === 429
                        ? "レート制限中のため取得できませんでした"
                        : res.status === 403
                          ? "トークンに user:profile スコープがありません（`claude login` で発行したものを使う必要があります）"
                          : `使用状況を取得できませんでした (${res.status})`,
            }
        }

        const { windows, billing } = parseClaudeUsageResponse((await res.json()) as OauthUsageResponse)

        if (windows.length === 0) {
            return { ...base, status: "error", message: "使用状況のレスポンスを解釈できませんでした" }
        }

        return { ...base, status: "ok", windows, billing }
    } catch (error) {
        console.error("Claude usage: 取得に失敗", error)
        return { ...base, status: "error", message: "使用状況の取得に失敗しました" }
    }
}
