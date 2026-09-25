import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
    addTypeSafeCreditPurchase,
    applyTypeSafeCreditLedger,
    correctTypeSafeCreditBalance,
    recordTypeSafeCreditUsage,
    tokensToMinor,
} from "@/lib/ai-usage/typesafe-credit-ledger"
import { makeProvider, makeSnapshot, redirectStateFile } from "@/lib/ai-usage/test-support"

function today(offsetYears = 0): string {
    const now = new Date()
    return `${now.getFullYear() + offsetYears}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

describe("tokensToMinor", () => {
    it("累計入力トークンを入力単価で1/10000ドル単位へ直す", () => {
        assert.equal(tokensToMinor(1_000_000), 420)
        assert.equal(tokensToMinor(0), 0)
    })
})

describe("applyTypeSafeCreditLedger", () => {
    it("未設定の提供元とTypeSafeが無いスナップショットはそのまま返す", async (t) => {
        redirectStateFile(t, "TYPESAFE_CREDIT_LEDGER_PATH")
        const unconfigured = makeSnapshot([makeProvider("typesafe", [], { status: "unconfigured" })])
        const none = makeSnapshot([makeProvider("claude", [])])

        assert.equal(await applyTypeSafeCreditLedger(unconfigured), unconfigured)
        assert.equal(await applyTypeSafeCreditLedger(none), none)
    })

    it("記録が無ければ「未記録」でバーは出さない", async (t) => {
        redirectStateFile(t, "TYPESAFE_CREDIT_LEDGER_PATH")
        const result = await applyTypeSafeCreditLedger(makeSnapshot([makeProvider("typesafe", [])]))
        const credit = result.providers[0].credit

        assert.equal(credit?.valueText, "未記録")
        assert.equal(credit?.usedPercent, null)
    })

    it("購入・補正・累計の消費から残りと使用率を出し、累計が届くまでは注記する", async (t) => {
        redirectStateFile(t, "TYPESAFE_CREDIT_LEDGER_PATH")
        await addTypeSafeCreditPurchase(today(), 100_000) // $10.0000
        await correctTypeSafeCreditBalance(80_000) // $8.0000

        const pending = (await applyTypeSafeCreditLedger(makeSnapshot([makeProvider("typesafe", [])]))).providers[0].credit
        assert.match(pending?.detailText ?? "", /使用額は累計待ち/)
        assert.equal(pending?.valueText, "残り $8.00")

        await recordTypeSafeCreditUsage(0)
        await recordTypeSafeCreditUsage(100_000_000) // 100M トークン = $4.2
        const credit = (await applyTypeSafeCreditLedger(makeSnapshot([makeProvider("typesafe", [])]))).providers[0].credit

        assert.equal(credit?.valueText, "残り $3.80")
        assert.equal(credit?.usedPercent, 62)
        assert.equal(credit?.reservedPercent, 38)
        assert.doesNotMatch(credit?.detailText ?? "", /累計待ち/)
    })

    it("累計が減っても（集計の欠け）二重に足さず、その後の増分だけを積む", async (t) => {
        redirectStateFile(t, "TYPESAFE_CREDIT_LEDGER_PATH")
        await addTypeSafeCreditPurchase(today(), 100_000)
        await correctTypeSafeCreditBalance(100_000)

        await recordTypeSafeCreditUsage(100_000_000) // 最初の観測は基準になるだけ
        await recordTypeSafeCreditUsage(50_000_000) // 減った: 足さない
        await recordTypeSafeCreditUsage(60_000_000) // +10M = $0.42
        const credit = (await applyTypeSafeCreditLedger(makeSnapshot([makeProvider("typesafe", [])]))).providers[0].credit

        assert.equal(credit?.valueText, "残り $9.58")
    })
})
