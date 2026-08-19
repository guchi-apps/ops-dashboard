import { fetchChatGptUsage } from "@/lib/ai-usage/chatgpt"
import { fetchClaudeUsage } from "@/lib/ai-usage/claude"
import {
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
    if (cached && isUsageCacheFresh(cached, force)) {
        return cached.snapshot
    }

    const [claude, chatgpt] = await Promise.all([fetchClaudeUsage(), fetchChatGptUsage()])
    const snapshot: AiUsageSnapshot = {
        providers: [claude, chatgpt],
        fetchedAt: new Date().toISOString(),
    }

    cache = newUsageCacheEntry(snapshot, getCacheTtlMs())
    return snapshot
}
