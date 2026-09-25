import {
    addCreditPurchase,
    correctCreditBalance,
    describeLedger,
    readState,
    recordCreditUsage,
    removeCreditPurchase,
    type LedgerConfig,
} from "@/lib/ai-usage/claude-credit-ledger"
import { TYPESAFE_INPUT_USD_PER_MILLION_TOKENS } from "@/lib/ai-usage/typesafe"
import type { AiProviderCredit, AiProviderUsage, AiUsageSnapshot, ClaudeCreditLedgerView } from "@/types/ai-usage"

/**
 * Jev（TypeSafe）のクレジット残高の台帳（#426）。
 *
 * TypeSafeの公開APIも連携元（issue-deck）の使用量APIも、残高・購入額を返さない。そのためClaudeと同じく
 * 購入と「ある時点の残高」を画面から登録し、そこからの消費を差し引いて残高を推定する。
 * 消費は連携先の累計入力トークン（`totalInputTokens`）を入力単価で金額に直して積む。累計が届かない間は
 * 補正値と購入だけで残高を出し、画面に「使用額は累計待ち」と添える。
 * Jevは1回の消費が数セント未満なので、最小単位はセントより細かく（1/10000ドル）取る。
 */
export const TYPESAFE_LEDGER: LedgerConfig = {
    currency: "USD",
    decimals: 4,
    envVar: "TYPESAFE_CREDIT_LEDGER_PATH",
    fileName: "typesafe-credit-ledger.json",
}

/** 累計入力トークン数を、台帳の最小単位の使用額へ */
export function tokensToMinor(totalInputTokens: number): number {
    return Math.round(
        (totalInputTokens * TYPESAFE_INPUT_USD_PER_MILLION_TOKENS * 10 ** TYPESAFE_LEDGER.decimals) / 1_000_000
    )
}

export const recordTypeSafeCreditUsage = (totalInputTokens: number) =>
    recordCreditUsage(tokensToMinor(totalInputTokens), TYPESAFE_LEDGER)
export const addTypeSafeCreditPurchase = (date: string, amountMinor: number) =>
    addCreditPurchase(date, amountMinor, TYPESAFE_LEDGER)
export const removeTypeSafeCreditPurchase = (id: string) => removeCreditPurchase(id, TYPESAFE_LEDGER)
export const correctTypeSafeCreditBalance = (balanceMinor: number) =>
    correctCreditBalance(balanceMinor, TYPESAFE_LEDGER)

interface CreditOptions {
    /** 累計の使用額をもう観測しているか */
    usageObserved: boolean
}

/**
 * 台帳の見た目をバー用の値にする。Jevには月の上限が無いので、有効な購入の合計をバーの全体とし、
 * 使用済み（購入 − 推定残高）と残りに分ける。補正が無ければバーは出さない
 */
export function toTypeSafeCredit(
    ledger: ClaudeCreditLedgerView,
    activePurchasedMinor: number,
    earliestExpiry: string | null,
    { usageObserved }: CreditOptions
): AiProviderCredit {
    const purchasedText = ledger.activePurchasedText ? `購入 ${ledger.activePurchasedText}（有効分）` : null
    const pendingText = usageObserved ? null : "使用額は累計待ち"

    const balance = ledger.balanceMinor
    const hasBar = balance !== null && activePurchasedMinor > 0
    const usedPercent = hasBar
        ? Math.min(100, Math.max(0, ((activePurchasedMinor - balance) / activePurchasedMinor) * 100))
        : null

    return {
        valueText: ledger.balanceText ? `残り ${ledger.balanceText}` : "未記録",
        usedPercent: usedPercent === null ? null : Math.round(usedPercent * 10) / 10,
        detailText: [purchasedText, pendingText].filter(Boolean).join(" · ") || null,
        resetsAt: earliestExpiry,
        reservedPercent: usedPercent === null ? undefined : Math.round((100 - usedPercent) * 10) / 10,
        ledger,
    }
}

function withCredit(provider: AiProviderUsage, credit: AiProviderCredit): AiProviderUsage {
    return { ...provider, credit }
}

/** スナップショットのTypeSafe（Jev）へ台帳のクレジット枠を載せる。未設定の提供元には載せない */
export async function applyTypeSafeCreditLedger(snapshot: AiUsageSnapshot): Promise<AiUsageSnapshot> {
    const target = snapshot.providers.find((provider) => provider.id === "typesafe")
    if (!target || target.status === "unconfigured") return snapshot

    const state = await readState(TYPESAFE_LEDGER)
    const now = new Date()
    const ledger = describeLedger(state, now, TYPESAFE_LEDGER)

    const active = ledger.purchases.filter((purchase) => !purchase.expired)
    const activeMinor = active.reduce((sum, purchase) => sum + Math.round(purchase.amount * 10 ** TYPESAFE_LEDGER.decimals), 0)
    const earliestExpiry =
        active.map((purchase) => purchase.expiresOn).sort()[0] ?? null

    const credit = toTypeSafeCredit(
        ledger,
        activeMinor,
        earliestExpiry ? new Date(`${earliestExpiry}T00:00:00`).toISOString() : null,
        { usageObserved: state.lastObservedMinor !== null }
    )

    return {
        ...snapshot,
        providers: snapshot.providers.map((provider) => (provider === target ? withCredit(provider, credit) : provider)),
    }
}
