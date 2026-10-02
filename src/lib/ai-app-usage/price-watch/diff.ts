import type { ModelInfo, ModelPrice } from "@/lib/ai-app-usage/models"
import type { OfficialPrice, PriceCandidate, WatchedProvider } from "@/lib/ai-app-usage/price-watch/types"

/**
 * 公式の単価と登録済みの単価表（`models.ts`）を突き合わせて更新候補を作る（#497）。純粋関数。
 * **単価表は書き換えない。** 人が候補を確かめて、出典付きで `models.ts` を直す。
 */

const PRICE_FIELDS: (keyof ModelPrice)[] = ["input", "output", "cacheWrite", "cacheRead"]

/** 価格の通貨・単位・適用条件。候補に添えて、何の価格かを取り違えないようにする */
const BASIS: Record<WatchedProvider, string> = {
    Anthropic: "USD/100万トークン・標準API価格・キャッシュ書き込みは5分",
    OpenAI: "USD/100万トークン・Standard・短文脈",
}

const SOURCE_URLS: Record<WatchedProvider, string> = {
    Anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
    OpenAI: "https://developers.openai.com/api/docs/pricing",
}

/** 日付付きのスナップショットID（`-20251001`・`-2025-10-01`）。別名として本体のIDへ寄せる */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/

/** 表示名の `Claude ` と空白の違いを無視して比べる */
const normalizeName = (name: string) => name.replace(/^claude\s+/i, "").trim().toLowerCase()

/**
 * 公式のモデルが登録済みのどれにあたるか。
 *
 * **`findModel` の前方一致は使わない。** `claude-sonnet-5-5`（Sonnet 5.5）が `claude-sonnet-5` への前方一致で
 * 「登録済み」に見え、新モデルを見逃してしまう（#362と同じ落とし穴）。完全一致と、日付付きIDだけを許す。
 */
export function matchRegistered(official: OfficialPrice, models: readonly ModelInfo[]): ModelInfo | null {
    const sameProvider = models.filter((info) => info.provider === official.provider)

    if (official.id) {
        const id = official.id.toLowerCase()
        const base = id.replace(DATE_SUFFIX, "")
        const byId = sameProvider.find((info) => info.id === id || info.id === base)
        if (byId) return byId
    }

    // IDで当たらない・IDを確かめられない（Anthropicの表示名のみ）ときは、登録済みの表示名と照合する
    const name = normalizeName(official.name)
    return sameProvider.find((info) => normalizeName(info.label) === name) ?? null
}

/** 公式の一覧の中の、日付付きIDの重複（`x` と `x-20260101` の両方がある）を本体へ寄せて1件にする */
export function dedupeAliases(prices: readonly OfficialPrice[]): OfficialPrice[] {
    const ids = new Set(prices.map((entry) => entry.id).filter((id): id is string => id !== null))
    return prices.filter((entry) => !(entry.id && DATE_SUFFIX.test(entry.id) && ids.has(entry.id.replace(DATE_SUFFIX, ""))))
}

const almostEqual = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** 公式の単価が `-`（その課金なし）の項目は比べない。登録側の仮定値を「公式と違う」とは言えないため */
function changedFields(registered: ModelPrice, official: NonNullable<OfficialPrice["price"]>): (keyof ModelPrice)[] {
    return PRICE_FIELDS.filter((field) => {
        const value = official[field]
        return value !== null && !almostEqual(registered[field], value)
    })
}

function candidateKey(
    kind: PriceCandidate["kind"],
    provider: WatchedProvider,
    ident: string,
    price: PriceCandidate["after"]
): string {
    // 価格が再び変わったときは別の差分として扱うため、公式の単価をキーに含める
    return [kind, provider, ident, price ? PRICE_FIELDS.map((field) => price[field]).join("/") : "-"].join(":")
}

export interface DiffInput {
    provider: WatchedProvider
    official: readonly OfficialPrice[]
    registered: readonly ModelInfo[]
    checkedAt: string
}

/**
 * 1提供元ぶんの更新候補。取得に成功した提供元に対してだけ呼ぶ（失敗を「差分なし」にしない）。
 *
 * - 追加: 公式に載っていて、単価表に無いモデル（利用履歴に出ていない未使用のモデルも含む）
 * - 価格変更: 登録済みと公式の単価が違う
 * - 出典確認: 「出典未確認」の注記が付いた単価が、公式と一致した（注記を外してよい）
 * - 掲載終了: 登録済みなのに公式の一覧から消えた（**行は消さない**。過去の期間の金額を「不明」にしないため）
 */
export function diffProvider({ provider, official, registered, checkedAt }: DiffInput): PriceCandidate[] {
    const sourceUrl = SOURCE_URLS[provider]
    const basis = BASIS[provider]
    const candidates: PriceCandidate[] = []
    const matched = new Set<string>()

    for (const entry of dedupeAliases(official)) {
        const info = matchRegistered(entry, registered)

        if (!info) {
            if (entry.retired) continue
            const after = entry.price
            candidates.push({
                key: candidateKey("add", provider, entry.id ?? `name:${entry.name}`, after),
                kind: "add",
                provider,
                id: entry.id,
                name: entry.name,
                before: null,
                after,
                changedFields: [],
                basis,
                note: entry.condition ?? (entry.id ? null : "ID未確定（公式のモデル概要で対応を確認できない）"),
                sourceUrl,
                checkedAt,
            })
            continue
        }

        matched.add(info.id)
        // 条件付き価格の行は通常価格として比べない
        if (!entry.price) continue

        const fields = changedFields(info.price, entry.price)
        if (fields.length > 0) {
            const after = entry.price
            candidates.push({
                key: candidateKey("change", provider, info.id, after),
                kind: "change",
                provider,
                id: info.id,
                name: info.label,
                before: info.price,
                after,
                changedFields: fields,
                basis,
                note: info.note ?? null,
                sourceUrl,
                checkedAt,
            })
        } else if (info.note?.includes("出典未確認")) {
            candidates.push({
                key: candidateKey("verify", provider, info.id, info.price),
                kind: "verify",
                provider,
                id: info.id,
                name: info.label,
                before: info.price,
                after: info.price,
                changedFields: [],
                basis,
                note: "公式の単価と一致。「出典未確認」の注記を外せる",
                sourceUrl,
                checkedAt,
            })
        }
    }

    for (const info of registered) {
        if (info.provider !== provider || matched.has(info.id)) continue
        candidates.push({
            key: candidateKey("delisted", provider, info.id, null),
            kind: "delisted",
            provider,
            id: info.id,
            name: info.label,
            before: info.price,
            after: null,
            changedFields: [],
            basis,
            note: "公式の料金表に載っていない。過去の金額の換算に使うため行は残す",
            sourceUrl,
            checkedAt,
        })
    }

    return candidates
}
