import { notifyUsageAlerts } from "@/lib/ai-usage/alerts"
import { fetchChatGptUsage } from "@/lib/ai-usage/chatgpt"
import { fetchClaudeUsage } from "@/lib/ai-usage/claude"
import { applyClaudeCreditLedger, recordClaudeCreditUsage } from "@/lib/ai-usage/claude-credit-ledger"
import { attachDayMarks } from "@/lib/ai-usage/day-marks"
import { applyAiUsageHistory } from "@/lib/ai-usage/history"
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
        return applyClaudeCreditLedger(cached.snapshot)
    }

    const [claude, chatgpt] = await Promise.all([fetchClaudeUsage(), fetchChatGptUsage()])

    // 取得のたびに観測を残し、週間枠に「1日ごとの区切り」を載せて返す（#243）
    const snapshot = await attachDayMarks({
        providers: [claude, chatgpt],
        fetchedAt: new Date().toISOString(),
    })

    // 終わった枠の実績はここでしか観測できない。キャッシュを返した回は記録しない
    // （同じ値を書き直すだけで、観測時刻だけが実態より新しくなってしまうため）
    await applyAiUsageHistory(snapshot)

    // クレジット残高の推定に使う使用額も、提供元から取れた回だけ積む（#252）
    const claudeMonthly = claude.status === "ok" ? claude.credit?.monthly : undefined
    if (claudeMonthly) await recordClaudeCreditUsage(claudeMonthly.usedMinor)

    // 上限に近づいた枠を端末へ通知する（#263）。送信を待つと画面の応答が遅れるため待たない。
    // キャッシュを返した回は値が変わっていないので判定しない
    void notifyUsageAlerts(snapshot).catch((error) => {
        console.error("AI usage alerts: 通知の判定・送信に失敗", error)
    })

    const failed = snapshot.providers.some((provider) => provider.status === "error")
    cache = newUsageCacheEntry(snapshot, failed ? ERROR_CACHE_SECONDS * 1000 : getCacheTtlMs())
    return applyClaudeCreditLedger(snapshot)
}
