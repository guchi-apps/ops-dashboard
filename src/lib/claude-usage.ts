import {
    claudeApiHeaders,
    CLAUDE_USAGE_URL,
    resolveClaudeAccessToken,
    shouldRetryAfterUnauthorized,
} from "@/lib/ai-usage/claude"
import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream"
import type { ClaudeUsageWidgetResponse } from "@/types/claude-usage"

/**
 * ウィジェット（Scriptable）向けに、Claude の利用枠を上流のJSONのまま中継する。
 *
 * ダッシュボード表示用の `getAiUsageSnapshot()` と取得元は同じだが、
 * ウィジェットは決まったキーだけを読む・失敗しても空にしたくない、という要件が異なるため
 * キャッシュもレスポンス形も分けている。
 */

/** ウィジェットは数分おきに更新されるうえ上流のレート制限が厳しいため、長めに保持する */
const TTL_MS = 10 * 60 * 1000

/** ウィジェット側のタイムアウトが8秒のため、それより先にこちらで打ち切る */
const TIMEOUT_MS = 8_000

let cache: { data: Record<string, unknown>; fetchedAt: number } | null = null

function shape(entry: NonNullable<typeof cache>, stale: boolean): ClaudeUsageWidgetResponse {
    return {
        ...entry.data,
        collected_at: new Date(entry.fetchedAt).toISOString(),
        stale,
    }
}

async function fetchUsage(): Promise<Record<string, unknown>> {
    let token = await resolveClaudeAccessToken()
    if (!token) {
        throw new Error("ANTHROPIC_OAUTH_REFRESH_TOKEN が未設定です")
    }

    const request = (accessToken: string) =>
        fetchWithTimeout(CLAUDE_USAGE_URL, { headers: claudeApiHeaders(accessToken) }, TIMEOUT_MS)

    let res = await request(token.accessToken)

    // 期限内でも失効したアクセストークンで 401 が返り続けないよう、1回だけ取り直す
    if (shouldRetryAfterUnauthorized(res.status, token)) {
        token = await resolveClaudeAccessToken(token.accessToken)
        if (token) res = await request(token.accessToken)
    }

    if (!res.ok) {
        throw new Error(`使用状況APIが ${res.status} を返しました: ${await readErrorBody(res)}`)
    }

    const data: unknown = await res.json()
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("使用状況のレスポンスを解釈できませんでした")
    }

    return data as Record<string, unknown>
}

/**
 * TTL内ならキャッシュを返す。上流に失敗してもキャッシュがあれば `stale: true` を付けて返し、
 * ウィジェットが空になることを避ける。キャッシュも無いときだけ例外を投げる。
 */
export async function getClaudeUsageForWidget(): Promise<ClaudeUsageWidgetResponse> {
    if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
        return shape(cache, false)
    }

    try {
        cache = { data: await fetchUsage(), fetchedAt: Date.now() }
        return shape(cache, false)
    } catch (error) {
        // アクセストークンは組み立てたヘッダーにしか載せていないため、ここには出ない
        console.warn("Claude usage (widget): 取得に失敗", describeError(error))

        if (cache) {
            return { ...shape(cache, true), error: describeError(error) }
        }
        throw error
    }
}
