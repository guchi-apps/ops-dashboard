import { fetchChatGptUsage } from "@/lib/ai-usage/chatgpt"
import { fetchClaudeUsage } from "@/lib/ai-usage/claude"
import type { AiUsageSnapshot } from "@/types/ai-usage"

/**
 * 各提供元のエンドポイントはいずれもレート制限が厳しく、
 * Anthropic 側は 180 秒以上の間隔が推奨されている。
 * 画面を開くたびに叩かないよう、プロセス内でスナップショットをキャッシュする。
 */
const DEFAULT_CACHE_SECONDS = 300

let cache: { snapshot: AiUsageSnapshot; expiresAt: number } | null = null

function getCacheTtlMs(): number {
    const configured = Number.parseInt(process.env.AI_USAGE_CACHE_SECONDS ?? "", 10)
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_SECONDS
    return seconds * 1000
}

export async function getAiUsageSnapshot(): Promise<AiUsageSnapshot> {
    if (cache && cache.expiresAt > Date.now()) {
        return cache.snapshot
    }

    const [claude, chatgpt] = await Promise.all([fetchClaudeUsage(), fetchChatGptUsage()])
    const snapshot: AiUsageSnapshot = {
        providers: [claude, chatgpt],
        fetchedAt: new Date().toISOString(),
    }

    cache = { snapshot, expiresAt: Date.now() + getCacheTtlMs() }
    return snapshot
}
