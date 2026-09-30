import { createSingleFlight } from "@/lib/usage-cache"
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
/** 取得に失敗した後、この間は取りにいかず直前の値（無ければフォールバック）を即座に返す（#468） */
const RETRY_AFTER_FAILURE_MS = 45 * 1000

export interface SharedTokenCacheEntry {
    /** 取得できていない間（失敗だけが続いている）は null */
    value: string | null
    /** 最後に取得できた時刻。取得できていなければ 0 */
    fetchedAtMs: number
    /** 直近の取得に失敗した時刻。成功すると消える */
    failedAtMs?: number
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
    /** issue-deckへ取りにいった（または失敗後の待機中）が、値を取得できていない状態 */
    failed?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/** 取得中の要求は名前ごとに1本へまとめる。同時に来た要求が全員issue-deckへ取りにいくのを避ける（#274と同じ考え方） */
const flights = new Map<string, ReturnType<typeof createSingleFlight<SharedTokenResult>>>()

/**
 * `previous`・戻り値の`cache`を呼び出し元のモジュール変数に持たせることで、副作用を
 * この関数の外へ出し、テストしやすくしている（history.tsの`applyAiUsageHistory`と同じ形）。
 *
 * 失敗したときは`failedAtMs`を覚え、`RETRY_AFTER_FAILURE_MS`のあいだは取りにいかない。
 * issue-deckが落ちている間に要求のたびに`TIMEOUT_MS`待たされるのを避けるため。
 */
export function resolveSharedToken(
    name: string,
    consumer: string,
    previous: SharedTokenCacheEntry | null,
    options: { now?: number } = {}
): Promise<SharedTokenResult> {
    const now = options.now ?? Date.now()

    if (previous?.value != null && !previous.failedAtMs && now - previous.fetchedAtMs < CACHE_MS) {
        return Promise.resolve({ value: previous.value, cache: previous })
    }

    const baseUrl = process.env.ISSUE_DECK_URL
    const secret = process.env.SHARED_TOKEN_API_SECRET
    if (!baseUrl || !secret) {
        return Promise.resolve({ value: previous?.value ?? null, cache: previous })
    }

    if (previous?.failedAtMs !== undefined && now - previous.failedAtMs < RETRY_AFTER_FAILURE_MS) {
        return Promise.resolve({ value: previous.value, cache: previous, failed: true })
    }

    let flight = flights.get(name)
    if (!flight) {
        flight = createSingleFlight<SharedTokenResult>()
        flights.set(name, flight)
    }
    return flight(() => fetchSharedToken(name, consumer, previous, now, baseUrl, secret))
}

async function fetchSharedToken(
    name: string,
    consumer: string,
    previous: SharedTokenCacheEntry | null,
    now: number,
    baseUrl: string,
    secret: string
): Promise<SharedTokenResult> {
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
        const cache: SharedTokenCacheEntry = {
            value: previous?.value ?? null,
            fetchedAtMs: previous?.fetchedAtMs ?? 0,
            failedAtMs: now,
        }
        return { value: cache.value, cache, failed: true }
    }
}
