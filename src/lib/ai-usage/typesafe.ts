import { fetchWithTimeout } from "@/lib/upstream"
import { getProviderEntry, type ProviderCacheEntry, type ProviderFetchResult } from "@/lib/ai-usage/provider-cache"
import type { AiMeteredFeatureUsage, AiMeteredTotals, AiProviderUsage } from "@/types/ai-usage"

/** TypeSafe Jev の入力単価。出力トークンは現在無料のため計上しない */
export const TYPESAFE_INPUT_USD_PER_MILLION_TOKENS = 0.042

interface RawTotals {
    calls?: unknown
    inputTokens?: unknown
}

interface RawFeature {
    label?: unknown
    last24h?: RawTotals
    last7d?: RawTotals
}

interface RawUsageResponse {
    totalLast24h?: RawTotals
    totalLast7d?: RawTotals
    features?: unknown
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function toTotals(value: RawTotals | undefined): AiMeteredTotals | null {
    const calls = readNonNegativeInteger(value?.calls)
    const inputTokens = readNonNegativeInteger(value?.inputTokens)
    if (calls === null || inputTokens === null) return null

    return {
        calls,
        inputTokens,
        estimatedCostUsd: (inputTokens * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS) / 1_000_000,
    }
}

/** 連携先の集計レスポンスを画面用の実測値へ変換する。不正な形は採用しない */
export function parseTypeSafeUsageResponse(data: unknown): AiProviderUsage["metered"] | null {
    if (!data || typeof data !== "object") return null
    const response = data as RawUsageResponse
    const last24h = toTotals(response.totalLast24h)
    const last7d = toTotals(response.totalLast7d)
    if (!last24h || !last7d) return null

    const features: AiMeteredFeatureUsage[] = Array.isArray(response.features)
        ? response.features.flatMap((value) => {
              if (!value || typeof value !== "object") return []
              const feature = value as RawFeature
              if (typeof feature.label !== "string" || feature.label.length === 0) return []
              const featureLast24h = toTotals(feature.last24h)
              const featureLast7d = toTotals(feature.last7d)
              return featureLast24h && featureLast7d
                  ? [{ label: feature.label, last24h: featureLast24h, last7d: featureLast7d }]
                  : []
          })
        : []

    return { last24h, last7d, features }
}

function unconfigured(message: string): ProviderFetchResult {
    return {
        usage: {
            id: "typesafe",
            name: "TypeSafe AI",
            plan: "Jev",
            status: "unconfigured",
            message,
            windows: [],
        },
    }
}

async function fetchTypeSafeUsage(): Promise<ProviderFetchResult> {
    const url = process.env.TYPESAFE_USAGE_URL?.trim()
    const token = process.env.TYPESAFE_USAGE_TOKEN?.trim()
    if (!url || !token) return unconfigured("TYPESAFE_USAGE_URL / TYPESAFE_USAGE_TOKEN が未設定です")

    try {
        const response = await fetchWithTimeout(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            cache: "no-store",
        })
        if (!response.ok) {
            return {
                usage: {
                    id: "typesafe",
                    name: "TypeSafe AI",
                    plan: "Jev",
                    status: "error",
                    message: `HTTP ${response.status}`,
                    windows: [],
                },
            }
        }

        const metered = parseTypeSafeUsageResponse(await response.json())
        if (!metered) {
            return {
                usage: {
                    id: "typesafe",
                    name: "TypeSafe AI",
                    plan: "Jev",
                    status: "error",
                    message: "応答の形式が想定と異なります",
                    windows: [],
                },
            }
        }

        return {
            usage: { id: "typesafe", name: "TypeSafe AI", plan: "Jev", status: "ok", windows: [], metered },
        }
    } catch {
        return {
            usage: {
                id: "typesafe",
                name: "TypeSafe AI",
                plan: "Jev",
                status: "error",
                message: "接続できません",
                windows: [],
            },
        }
    }
}

/** TypeSafeの呼び出し元が集計した実測使用量を、提供元ごとのキャッシュを通して返す */
export function getTypeSafeUsageEntry(force = false): Promise<ProviderCacheEntry> {
    return getProviderEntry("typesafe", fetchTypeSafeUsage, force)
}
