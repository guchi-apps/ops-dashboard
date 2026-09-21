import { collectAiAppUsage } from "@/lib/ai-app-usage/collect"
import { parseSources } from "@/lib/ai-app-usage/sources"
import { getTypeSafeUsageEntry } from "@/lib/ai-usage/typesafe"
import {
    createSingleFlight,
    isUsageCacheFresh,
    newUsageCacheEntry,
    type UsageCacheEntry,
    type UsageFetchOptions,
} from "@/lib/usage-cache"
import type { AiAppUsageSnapshot } from "@/types/ai-app-usage"

/**
 * 連携先のアプリが集計した使用量を、アプリ別に返す（#325）。
 *
 * 連携先は自分たちのアプリで、外部サービスのようなレート制限は無い。ただし画面のポーリングと
 * 手動更新が重なっても取りにいく回数を増やさないよう、AI・GitHubと同じ5分のキャッシュと、
 * 取得中の要求の相乗りを通す。失敗したアプリがあるときだけ短く持ち、直ったらすぐ戻る。
 */
const CACHE_SECONDS = 300
const ERROR_CACHE_SECONDS = 30

let cache: UsageCacheEntry<AiAppUsageSnapshot> | null = null
const singleFlight = createSingleFlight<UsageCacheEntry<AiAppUsageSnapshot>>()

/** 壊れた設定を毎回ログへ出さないよう、直前に出した内容を覚えておく */
let lastConfigError: string | null = null

async function fetchSnapshot(force: boolean): Promise<UsageCacheEntry<AiAppUsageSnapshot>> {
    const { sources, error } = parseSources(process.env.AI_APP_USAGE_SOURCES)
    if (error !== lastConfigError) {
        lastConfigError = error
        if (error) console.error(`AI app usage: ${error}`)
    }

    // 既存のTypeSafe連携は自前のキャッシュを持つので、ここでは追加の問い合わせにならない
    const typesafe = (await getTypeSafeUsageEntry(force)).snapshot.usage

    const apps = await collectAiAppUsage({
        sources,
        token: process.env.OPS_API_TOKEN?.trim() || undefined,
        typesafe,
    })

    const ttlSeconds = apps.some((app) => app.status === "error") ? ERROR_CACHE_SECONDS : CACHE_SECONDS
    const now = Date.now()
    return newUsageCacheEntry({ apps, fetchedAt: new Date(now).toISOString() }, ttlSeconds * 1000, now)
}

export async function getAiAppUsageSnapshot({ force = false }: UsageFetchOptions = {}): Promise<AiAppUsageSnapshot> {
    // キャッシュの判定から取得の開始までに await を挟まない（挟むと相乗りをすり抜ける。usage-cache.ts）
    if (cache && isUsageCacheFresh(cache, force)) return cache.snapshot

    const entry = await singleFlight(async () => {
        const fetched = await fetchSnapshot(force)
        cache = fetched
        return fetched
    })
    return entry.snapshot
}
