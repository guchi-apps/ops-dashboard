import { fetchChatGptUsage } from "@/lib/ai-usage/chatgpt"
import { fetchClaudeUsage } from "@/lib/ai-usage/claude"
import {
    AI_MIN_FORCE_REFRESH_MS,
    isUsageCacheFresh,
    newUsageCacheEntry,
    type UsageCacheEntry,
    type UsageFetchOptions,
} from "@/lib/usage-cache"
import type { AiUsageSnapshot } from "@/types/ai-usage"

/**
 * 各提供元のエンドポイントはいずれもレート制限が厳しく、
 * Anthropic 側は 180 秒以上の間隔が推奨されている。
 * 画面を開くたびに叩かないよう、プロセス内でスナップショットをキャッシュする。
 */
const DEFAULT_CACHE_SECONDS = 300

/**
 * 取得に失敗したスナップショットは通常より短くしか持たない。
 * 429などの一時的な失敗を5分抱えると、カードがその間ずっとエラー表示のままになるため
 * （GitHub・1Passwordと同じ扱い）。設定していない提供元は待っても変わらないので対象にしない。
 */
const ERROR_CACHE_SECONDS = 30

let cache: UsageCacheEntry<AiUsageSnapshot> | null = null

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.AI_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

export async function getAiUsageSnapshot({
    force = false,
}: UsageFetchOptions = {}): Promise<AiUsageSnapshot> {
    const cached = cache
    if (cached && isUsageCacheFresh(cached, force, AI_MIN_FORCE_REFRESH_MS)) {
        return cached.snapshot
    }

    const [claude, chatgpt] = await Promise.all([fetchClaudeUsage(), fetchChatGptUsage()])
    const snapshot: AiUsageSnapshot = {
        providers: [claude, chatgpt],
        fetchedAt: new Date().toISOString(),
    }

    const failed = snapshot.providers.some((provider) => provider.status === "error")
    cache = newUsageCacheEntry(snapshot, failed ? ERROR_CACHE_SECONDS * 1000 : getCacheTtlMs())
    return snapshot
}
