import { notifyUsageAlerts } from "@/lib/ai-usage/alerts"
import { getChatGptUsageEntry } from "@/lib/ai-usage/chatgpt"
import { getClaudeUsageEntry } from "@/lib/ai-usage/claude"
import { getTypeSafeUsageEntry } from "@/lib/ai-usage/typesafe"
import { applyClaudeCreditLedger, recordClaudeCreditUsage } from "@/lib/ai-usage/claude-credit-ledger"
import { applyTypeSafeCreditLedger, recordTypeSafeCreditUsage } from "@/lib/ai-usage/typesafe-credit-ledger"
import { attachDayMarks } from "@/lib/ai-usage/day-marks"
import { applyAiUsageHistory } from "@/lib/ai-usage/history"
import type { ProviderCacheEntry } from "@/lib/ai-usage/provider-cache"
import type { UsageFetchOptions } from "@/lib/usage-cache"
import type { AiProviderUsage, AiUsageSnapshot } from "@/types/ai-usage"

/**
 * 提供元の取得結果はそれぞれのキャッシュ（`provider-cache.ts`）が持ち、TTLも提供元ごとに決まる（#273）。
 * `provider-cache.ts` 側で取得中の要求を1つに相乗りさせているため（#274 の考え方を提供元単位にしたもの）、
 * ここでは取り直された結果だけを記録（日の区切り・使い切りの実績・クレジット・通知）へ回し、
 * 記録を載せた結果を提供元ごとに覚えておく。
 */
const recorded = new WeakMap<ProviderCacheEntry, AiProviderUsage>()

/** 記録ファイルへの書き込みが重ならないよう、同じ取得結果を二重に記録しないよう直列化する */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/**
 * まだ記録していない取得結果を記録へ回し、記録を載せた使用状況を返す。
 *
 * キャッシュを返した回は記録しない（同じ値を書き直すだけで、観測時刻だけが実態より新しくなって
 * しまうため）。ウィジェットが先にClaudeを取り直した場合も、ここで初めて記録される。
 */
async function record(entry: ProviderCacheEntry): Promise<{ usage: AiProviderUsage; fresh: boolean }> {
    const done = recorded.get(entry)
    if (done) return { usage: done, fresh: false }

    const observed: AiUsageSnapshot = {
        providers: [{ ...entry.snapshot.usage }],
        fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
    }

    // 取得のたびに観測を残し、週間枠に「1日ごとの区切り」を載せる（#243）
    const snapshot = await attachDayMarks(observed, entry.fetchedAtMs)

    // 終わった枠の実績はここでしか観測できない
    await applyAiUsageHistory(snapshot)

    // クレジット残高の推定に使う使用額も、提供元から取れた回だけ積む（#252）
    const usage = snapshot.providers[0]
    const claudeMonthly = usage.id === "claude" && usage.status === "ok" ? usage.credit?.monthly : undefined
    if (claudeMonthly) await recordClaudeCreditUsage(claudeMonthly.usedMinor)

    // Jevのクレジット残高の消費額は、連携先の累計入力トークンから積む（#426）
    const totalInputTokens = usage.id === "typesafe" && usage.status === "ok" ? usage.metered?.totalInputTokens : undefined
    if (totalInputTokens !== undefined) await recordTypeSafeCreditUsage(totalInputTokens)

    recorded.set(entry, usage)
    return { usage, fresh: true }
}

export async function getAiUsageSnapshot({
    force = false,
}: UsageFetchOptions = {}): Promise<AiUsageSnapshot> {
    const entries = await Promise.all([
        getClaudeUsageEntry(force),
        getChatGptUsageEntry(force),
        getTypeSafeUsageEntry(force),
    ])

    const results = await serialize(async () => {
        const recordedResults = []
        for (const entry of entries) recordedResults.push(await record(entry))
        return recordedResults
    })

    // 上限に近づいた枠を端末へ通知する（#263）。送信を待つと画面の応答が遅れるため待たない。
    // キャッシュを返した提供元は値が変わっていないので判定しない
    const fresh = results.filter((result) => result.fresh).map((result) => result.usage)
    if (fresh.length > 0) {
        void notifyUsageAlerts({ providers: fresh, fetchedAt: new Date().toISOString() }).catch((error) => {
            console.error("AI usage alerts: 通知の判定・送信に失敗", error)
        })
    }

    // 提供元ごとに取得時刻が違うため、画面の「取得」時刻はいちばん古いものを出す
    // （新しい方を出すと、キャッシュを返している側まで今取れたように見える）
    const oldest = Math.min(...entries.map((entry) => entry.fetchedAtMs))

    // 台帳の値は記録直後に画面へ出すため、キャッシュを返す回も毎回載せ直す
    return applyTypeSafeCreditLedger(
        await applyClaudeCreditLedger({
            providers: results.map((result) => result.usage),
            fetchedAt: new Date(oldest).toISOString(),
        })
    )
}
