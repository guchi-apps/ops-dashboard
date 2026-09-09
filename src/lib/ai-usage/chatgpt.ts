import { clampPercent, fetchWithTimeout, readErrorBody } from "@/lib/upstream"
import { formatWindowLabel } from "@/lib/ai-usage/common"
import {
    describeRefreshFailure,
    getAccessToken,
    isInvalidGrantResponse,
    RefreshTokenRevokedError,
    type AccessToken,
    type RefreshResult,
} from "@/lib/ai-usage/token-store"
import type { AiProviderCredit, AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

/**
 * Codex CLI が `/status` の表示に使っているのと同じエンドポイントを叩く。
 * 公式に文書化されたAPIではないため、仕様変更で壊れうる前提で扱う。
 */
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** 失効したときに画面へ出す、差し替える対象の環境変数名 */
const REFRESH_TOKEN_ENV_KEY = "OPENAI_CHATGPT_REFRESH_TOKEN"

/** リフレッシュのレスポンスに有効期限が入らないため、JWTから読めなかったときの既定値 */
const FALLBACK_TOKEN_TTL_SECONDS = 15 * 60

interface RateLimitWindow {
    used_percent?: number
    limit_window_seconds?: number
    reset_after_seconds?: number
    /** リセット時刻（epoch 秒） */
    reset_at?: number
}

/**
 * サブスクとは別に前払いで購入するクレジット。残高だけが返り、購入した総量は返らないため
 * 使用率（分母）は出せない。`balance` は数値ではなく文字列で返る。
 */
interface CreditsResponse {
    has_credits?: boolean | null
    unlimited?: boolean | null
    balance?: string | null
    /** 残高で送れるメッセージ数の目安。[最小, 最大] */
    approx_local_messages?: number[] | null
}

interface UsageResponse {
    plan_type?: string
    rate_limit?: {
        allowed?: boolean
        limit_reached?: boolean
        primary_window?: RateLimitWindow | null
        secondary_window?: RateLimitWindow | null
    } | null
    credits?: CreditsResponse | null
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
        const body = await readErrorBody(res)
        if (isInvalidGrantResponse(res.status, body)) {
            throw new RefreshTokenRevokedError("ChatGPT", REFRESH_TOKEN_ENV_KEY, body)
        }
        throw new Error(`トークンの更新に失敗しました (${res.status}): ${body}`)
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

/** 残高で送れるメッセージ数の目安。上下が同じなら1つだけ出す */
function formatApproxMessages(range: number[] | null | undefined): string | null {
    if (!Array.isArray(range) || range.length === 0) return null

    const [min, max = min] = range
    if (typeof min !== "number" || typeof max !== "number" || max <= 0) return null

    return min === max ? `およそ ${max} メッセージ分` : `およそ ${min}〜${max} メッセージ分`
}

function toCredit(source: CreditsResponse | null | undefined): AiProviderCredit | undefined {
    if (!source) return undefined

    if (source.unlimited) {
        return {
            valueText: "無制限",
            usedPercent: null,
            detailText: "上限はありません",
            resetsAt: null,
        }
    }

    const balance = Number.parseFloat(source.balance ?? "")
    if (!Number.isFinite(balance)) return undefined

    // 購入した総量は返らないため分母を出せない。バーは使わず残高だけを出す
    return {
        valueText: `残り ${balance.toLocaleString("ja-JP")} クレジット`,
        usedPercent: null,
        detailText:
            balance > 0
                ? formatApproxMessages(source.approx_local_messages)
                : "購入したクレジットはありません",
        resetsAt: null,
    }
}

/** レスポンスから表示に使う制限枠とクレジット枠を取り出す */
export function parseChatGptUsageResponse(data: UsageResponse): {
    windows: AiUsageWindow[]
    credit?: AiProviderCredit
} {
    const windows = [
        toWindow(data.rate_limit?.primary_window),
        toWindow(data.rate_limit?.secondary_window),
    ].filter((window): window is AiUsageWindow => window !== null)

    return { windows, credit: toCredit(data.credits) }
}

function requestUsage(accessToken: string, accountId: string): Promise<Response> {
    return fetchWithTimeout(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "ChatGPT-Account-Id": accountId,
            "User-Agent": "codex-cli",
            Accept: "application/json",
        },
    })
}

/** レスポンス本文の `detail` を画面に出せる長さで取り出す */
function readDetail(body: string): string | null {
    try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== "object") return null

        const detail = (parsed as { detail?: unknown }).detail
        return typeof detail === "string" && detail.length > 0 ? detail.slice(0, 120) : null
    } catch {
        return null
    }
}

/**
 * 失敗の原因を画面から判別できるようにする。
 * 401 はトークンを更新してもなお認証されなかったときにしか出ないため、再ログインを促す。
 */
function describeUsageError(status: number, body: string): string {
    if (status === 401) {
        return `認証されませんでした (401)。ChatGPTへ再ログインして ${REFRESH_TOKEN_ENV_KEY} を更新してください`
    }

    const detail = readDetail(body)
    return detail
        ? `使用状況を取得できませんでした (${status}): ${detail}`
        : `使用状況を取得できませんでした (${status})`
}

export async function fetchChatGptUsage(): Promise<AiProviderUsage> {
    const base: Omit<AiProviderUsage, "status"> = {
        id: "chatgpt",
        name: "ChatGPT",
        plan: process.env.CHATGPT_PLAN_NAME || null,
        windows: [],
    }

    const refreshToken = process.env[REFRESH_TOKEN_ENV_KEY]
    const accountId = process.env.OPENAI_CHATGPT_ACCOUNT_ID

    if (!refreshToken || !accountId) {
        return {
            ...base,
            status: "unconfigured",
            message: `${REFRESH_TOKEN_ENV_KEY} / OPENAI_CHATGPT_ACCOUNT_ID が未設定です`,
        }
    }

    let token: AccessToken
    try {
        token = await getAccessToken("chatgpt", refreshToken, refreshAccessToken)
    } catch (error) {
        console.error("ChatGPT usage: トークン更新に失敗", error)
        return {
            ...base,
            status: "error",
            message: describeRefreshFailure(error),
        }
    }

    try {
        let res = await requestUsage(token.accessToken, accountId)

        // アクセストークンは有効期限が残っていても失効することがある（別端末での再ログインや
        // ログアウトなど）。期限だけを見て使い回すと、保存済みのトークンが失効した時点から
        // 401 が返り続け、更新のきっかけが二度と来ない。Codex CLI も 401 を受けたら
        // トークンを更新してやり直すので、同じ手順を踏む。
        if (res.status === 401 && !token.refreshed) {
            try {
                token = await getAccessToken("chatgpt", refreshToken, refreshAccessToken, {
                    invalidate: token.accessToken,
                })
            } catch (error) {
                console.error("ChatGPT usage: 401 を受けたあとのトークン更新に失敗", error)
                return {
                    ...base,
                    status: "error",
                    message: describeRefreshFailure(error),
                }
            }

            res = await requestUsage(token.accessToken, accountId)
        }

        if (!res.ok) {
            const body = await readErrorBody(res)
            console.error("ChatGPT usage API error:", res.status, body)
            return {
                ...base,
                status: "error",
                message: describeUsageError(res.status, body),
            }
        }

        const data = (await res.json()) as UsageResponse
        const planType = data.plan_type
        const plan = planType ? (PLAN_LABELS[planType] ?? planType) : base.plan

        const { windows, credit } = parseChatGptUsageResponse(data)

        if (windows.length === 0) {
            return { ...base, plan, status: "error", message: "使用状況のレスポンスを解釈できませんでした" }
        }

        return { ...base, plan, status: "ok", windows, credit }
    } catch (error) {
        console.error("ChatGPT usage: 取得に失敗", error)
        return { ...base, status: "error", message: "使用状況の取得に失敗しました" }
    }
}
