import {
    clampPercent,
    describeError,
    fetchWithTimeout,
    readErrorBody,
} from "@/lib/upstream"
import { formatWindowLabel } from "@/lib/ai-usage/common"
import { getAccessToken, type RefreshResult } from "@/lib/ai-usage/token-store"
import type { AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

/**
 * Codex CLI が `/status` の表示に使っているのと同じエンドポイントを叩く。
 * 公式に文書化されたAPIではないため、仕様変更で壊れうる前提で扱う。
 */
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** リフレッシュのレスポンスに有効期限が入らないため、JWTから読めなかったときの既定値 */
const FALLBACK_TOKEN_TTL_SECONDS = 15 * 60

interface RateLimitWindow {
    used_percent?: number
    limit_window_seconds?: number
    reset_after_seconds?: number
    /** リセット時刻（epoch 秒） */
    reset_at?: number
}

interface UsageResponse {
    plan_type?: string
    rate_limit?: {
        allowed?: boolean
        limit_reached?: boolean
        primary_window?: RateLimitWindow | null
        secondary_window?: RateLimitWindow | null
    } | null
}

interface TokenResponse {
    access_token?: string
    refresh_token?: string
}

const PLAN_LABELS: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    education: "Education",
}

/** JWT の exp クレームから有効期間（秒）を読む。読めなければ undefined */
function readExpiresInSeconds(accessToken: string): number | undefined {
    const payload = accessToken.split(".")[1]
    if (!payload) return undefined

    try {
        const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
        if (!decoded || typeof decoded !== "object") return undefined

        const exp = (decoded as { exp?: unknown }).exp
        if (typeof exp !== "number") return undefined

        const remaining = exp - Math.floor(Date.now() / 1000)
        return remaining > 0 ? remaining : undefined
    } catch {
        return undefined
    }
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
    const res = await fetchWithTimeout(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }),
    })

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
        expiresInSeconds: readExpiresInSeconds(data.access_token) ?? FALLBACK_TOKEN_TTL_SECONDS,
    }
}

function toWindow(source: RateLimitWindow | null | undefined): AiUsageWindow | null {
    if (!source || typeof source.used_percent !== "number") return null

    const resetsAt =
        typeof source.reset_at === "number"
            ? new Date(source.reset_at * 1000).toISOString()
            : typeof source.reset_after_seconds === "number"
              ? new Date(Date.now() + source.reset_after_seconds * 1000).toISOString()
              : null

    const windowSeconds =
        typeof source.limit_window_seconds === "number" && source.limit_window_seconds > 0
            ? source.limit_window_seconds
            : null

    return {
        label: formatWindowLabel(windowSeconds ?? 0),
        usedPercent: clampPercent(source.used_percent),
        resetsAt,
        windowSeconds,
    }
}

export async function fetchChatGptUsage(): Promise<AiProviderUsage> {
    const base: Omit<AiProviderUsage, "status"> = {
        id: "chatgpt",
        name: "ChatGPT",
        plan: process.env.CHATGPT_PLAN_NAME || null,
        windows: [],
    }

    const refreshToken = process.env.OPENAI_CHATGPT_REFRESH_TOKEN
    const accountId = process.env.OPENAI_CHATGPT_ACCOUNT_ID

    if (!refreshToken || !accountId) {
        return {
            ...base,
            status: "unconfigured",
            message: "OPENAI_CHATGPT_REFRESH_TOKEN / OPENAI_CHATGPT_ACCOUNT_ID が未設定です",
        }
    }

    let accessToken: string
    try {
        accessToken = await getAccessToken("chatgpt", refreshToken, refreshAccessToken)
    } catch (error) {
        console.error("ChatGPT usage: トークン更新に失敗", error)
        return {
            ...base,
            status: "error",
            message: `認証トークンを更新できませんでした: ${describeError(error)}`,
        }
    }

    try {
        const res = await fetchWithTimeout(USAGE_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "ChatGPT-Account-Id": accountId,
                "User-Agent": "codex-cli",
                Accept: "application/json",
            },
        })

        if (!res.ok) {
            console.error("ChatGPT usage API error:", res.status, await readErrorBody(res))
            return {
                ...base,
                status: "error",
                message: `使用状況を取得できませんでした (${res.status})`,
            }
        }

        const data = (await res.json()) as UsageResponse
        const planType = data.plan_type
        const plan = planType ? (PLAN_LABELS[planType] ?? planType) : base.plan

        const windows = [
            toWindow(data.rate_limit?.primary_window),
            toWindow(data.rate_limit?.secondary_window),
        ].filter((window): window is AiUsageWindow => window !== null)

        if (windows.length === 0) {
            return { ...base, plan, status: "error", message: "使用状況のレスポンスを解釈できませんでした" }
        }

        return { ...base, plan, status: "ok", windows }
    } catch (error) {
        console.error("ChatGPT usage: 取得に失敗", error)
        return { ...base, status: "error", message: "使用状況の取得に失敗しました" }
    }
}
