import { AI_MIN_FORCE_REFRESH_MS, isUsageCacheFresh, newUsageCacheEntry, type UsageCacheEntry } from "@/lib/usage-cache"
import type { AiProviderId, AiProviderUsage } from "@/types/ai-usage"

/**
 * AIの提供元ごとに取得結果をキャッシュする（#273）。
 *
 * 以前はスナップショット全体を1つのキャッシュに載せていたため、片方の提供元がエラーのままだと
 * エラー用の短いTTLに引きずられて、正常なもう片方まで毎分問い合わせていた。
 * 提供元ごとに分け、TTLも提供元ごとの取得結果で決める。
 *
 * ウィジェット（`src/lib/claude-usage.ts`）も同じClaudeのキャッシュを読む。別々に持つと、
 * 両方の取得が重なったときに同じエンドポイントへの間隔が180秒を割るため。
 */

/** 提供元から取得した1回ぶんの結果 */
export interface ProviderFetchResult {
    usage: AiProviderUsage
    /**
     * 再試行しても直らない失敗（リフレッシュトークンの失効）なら true。
     * 利用者が再ログインしてトークンを差し替えるまで変わらないため、短いTTLで取り直さない
     */
    permanent?: boolean
    /** 上流のレスポンス本文。Claudeのみで、ウィジェットへ素通しする */
    raw?: Record<string, unknown>
}

/**
 * 各提供元のエンドポイントはいずれもレート制限が厳しく、
 * Anthropic 側は 180 秒以上の間隔が推奨されている。
 */
const DEFAULT_CACHE_SECONDS = 300

/**
 * 一時的な失敗（429・通信エラーなど）は通常より短くしか持たない。
 * 5分抱えると、カードがその間ずっとエラー表示のままになるため（GitHub・1Passwordと同じ扱い）。
 * 設定していない提供元・失効したトークンは待っても変わらないので対象にしない。
 */
const ERROR_CACHE_SECONDS = 30

/**
 * 失敗時や `AI_USAGE_CACHE_SECONDS` を短くしたときでも、この間隔より短くは取り直さない。
 * Claudeは180秒未満で叩くと429になり、エラー時に短く取り直すとレート制限を自分で長引かせる
 */
const MIN_CACHE_MS: Record<AiProviderId, number> = {
    claude: AI_MIN_FORCE_REFRESH_MS,
    chatgpt: 0,
}

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.AI_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

/** 取得結果をどれだけ持つか */
export function getProviderTtlMs(result: ProviderFetchResult): number {
    const ttlMs =
        result.usage.status !== "error" || result.permanent ? getCacheTtlMs() : ERROR_CACHE_SECONDS * 1000
    return Math.max(ttlMs, MIN_CACHE_MS[result.usage.id])
}

export type ProviderCacheEntry = UsageCacheEntry<ProviderFetchResult>

interface ProviderCache {
    entry: ProviderCacheEntry | null
    inflight: Promise<ProviderCacheEntry> | null
}

const caches = new Map<AiProviderId, ProviderCache>()

/**
 * 提供元の取得結果を返す。キャッシュが新しければそれを、古ければ取り直した結果を返す。
 * 取得中に別の呼び出しが来たら、同じ取得の完了を待たせる（二重に問い合わせない）。
 */
export function getProviderEntry(
    id: AiProviderId,
    fetcher: () => Promise<ProviderFetchResult>,
    force = false
): Promise<ProviderCacheEntry> {
    let cache = caches.get(id)
    if (!cache) {
        cache = { entry: null, inflight: null }
        caches.set(id, cache)
    }

    if (cache.entry && isUsageCacheFresh(cache.entry, force, AI_MIN_FORCE_REFRESH_MS)) {
        return Promise.resolve(cache.entry)
    }
    if (cache.inflight) return cache.inflight

    const current = cache
    const run = fetcher()
        .then((result) => {
            const entry = newUsageCacheEntry(result, getProviderTtlMs(result))
            current.entry = entry
            return entry
        })
        .finally(() => {
            current.inflight = null
        })
    current.inflight = run
    return run
}
