import { fetchWithTimeout } from "@/lib/upstream"

/**
 * issue-deckの共有トークンAPI（guchi-apps/issue-deck の docs/shared-token-api.md）から、
 * 他アプリ用に登録したトークンを読む（#444）。1Passwordへ値を複製せず、issue-deckを
 * 唯一の正にする「方式A」の最初の適用先がAIDE_STATUS_TOKEN。同じ形は他のトークンでも
 * 使う想定のため、名前・利用元を引数に取る。
 *
 * `SHARED_TOKEN_API_SECRET`（issue-deck側の値と同じ）・`ISSUE_DECK_URL`が両方揃っていない
 * 環境（worktree・移行前）では、この経路は使わず呼び出し元でのフォールバックに委ねる。
 */

const CACHE_MS = 10 * 60 * 1000
const TIMEOUT_MS = 5_000

export interface SharedTokenCacheEntry {
    value: string
    fetchedAtMs: number
}

export interface SharedTokenResult {
    /**
     * 取得できたトークン値。取得元の優先順位:
     * 1. キャッシュが新しければそれ
     * 2. issue-deckから取得できればそれ
     * 3. 取得に失敗した・未設定なら、古くても直前のキャッシュ値
     * 4. キャッシュも無ければ null（呼び出し側で環境変数へのフォールバックを行う）
     */
    value: string | null
    /** 呼び出し元が次回へ引き継ぐキャッシュ。取得に失敗しても直前の値を保つ */
    cache: SharedTokenCacheEntry | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/**
 * `previous`・戻り値の`cache`を呼び出し元のモジュール変数に持たせることで、副作用を
 * この関数の外へ出し、テストしやすくしている（history.tsの`applyAiUsageHistory`と同じ形）。
 */
export async function resolveSharedToken(
    name: string,
    consumer: string,
    previous: SharedTokenCacheEntry | null,
    options: { now?: number } = {}
): Promise<SharedTokenResult> {
    const now = options.now ?? Date.now()

    if (previous && now - previous.fetchedAtMs < CACHE_MS) {
        return { value: previous.value, cache: previous }
    }

    const baseUrl = process.env.ISSUE_DECK_URL
    const secret = process.env.SHARED_TOKEN_API_SECRET
    if (!baseUrl || !secret) {
        return { value: previous?.value ?? null, cache: previous }
    }

    try {
        const url = `${baseUrl.replace(/\/+$/, "")}/api/shared-tokens?name=${encodeURIComponent(name)}`
        const res = await fetchWithTimeout(
            url,
            {
                headers: {
                    authorization: `Bearer ${secret}`,
                    "x-shared-token-consumer": consumer,
                    accept: "application/json",
                },
            },
            TIMEOUT_MS
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const payload = (await res.json()) as unknown
        if (!isRecord(payload) || typeof payload.value !== "string") {
            throw new SyntaxError("unexpected payload")
        }

        return { value: payload.value, cache: { value: payload.value, fetchedAtMs: now } }
    } catch (error) {
        console.error(`共有トークンの取得に失敗しました(${name}):`, error instanceof Error ? error.message : error)
        return { value: previous?.value ?? null, cache: previous }
    }
}
