import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import {
    applyClaudeCreditLedger,
    correctClaudeCreditBalance,
    describeLedger,
    getReservedPercent,
    isValidDateKey,
    recordClaudeCreditUsage,
    toMinorUnits,
} from "@/lib/ai-usage/claude-credit-ledger"
import { makeProvider, makeSnapshot, redirectStateFile } from "@/lib/ai-usage/test-support"
import type { AiProviderCredit } from "@/types/ai-usage"

type LedgerState = Parameters<typeof describeLedger>[0]

function setup(t: TestContext) {
    return redirectStateFile(t, "CLAUDE_CREDIT_LEDGER_PATH")
}

async function readLedger(file: string): Promise<LedgerState> {
    return JSON.parse(await readFile(file, "utf8"))
}

function purchase(date: string, amountMinor: number, id = date, recordedAt = "2026-01-01T00:00:00.000Z") {
    return { id, date, amountMinor, recordedAt }
}

function state(overrides: Partial<LedgerState> = {}): LedgerState {
    return { purchases: [], correction: null, usedTotalMinor: 0, lastObservedMinor: null, ...overrides }
}

/** 実行環境のタイムゾーンによらず「その日の昼」になるローカル時刻 */
function localNoon(year: number, month: number, day: number) {
    return new Date(year, month - 1, day, 12)
}

describe("recordClaudeCreditUsage: 使用額の積み上げ", () => {
    it("最初の観測は起点にするだけで、累計へは足さない", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(1_200)

        const saved = await readLedger(file)
        assert.equal(saved.usedTotalMinor, 0)
        assert.equal(saved.lastObservedMinor, 1_200)
    })

    it("増えた分だけ累計へ足す", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(1_200)
        await recordClaudeCreditUsage(1_500)
        await recordClaudeCreditUsage(1_900)

        const saved = await readLedger(file)
        assert.equal(saved.usedTotalMinor, 700)
        assert.equal(saved.lastObservedMinor, 1_900)
    })

    it("値が減ったら月のリセットとみなし、減った後の値をそのまま足す", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(5_000)
        await recordClaudeCreditUsage(6_000) // +1000
        await recordClaudeCreditUsage(300) // リセット後の新しい月の使用額 +300
        await recordClaudeCreditUsage(800) // +500

        const saved = await readLedger(file)
        assert.equal(saved.usedTotalMinor, 1_000 + 300 + 500)
        assert.equal(saved.lastObservedMinor, 800)
    })

    it("リセット後の値が0なら何も足さず、そこを新しい起点にする", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(5_000)
        await recordClaudeCreditUsage(0)
        await recordClaudeCreditUsage(200)

        const saved = await readLedger(file)
        assert.equal(saved.usedTotalMinor, 200)
    })

    it("同じ値の観測は書き込まない", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(1_200)
        const before = await readFile(file, "utf8")
        await writeFile(file, `${before}\n`) // 書き換えられたら消える目印
        await recordClaudeCreditUsage(1_200)

        assert.equal(await readFile(file, "utf8"), `${before}\n`)
    })

    it("数値でない・負の観測は無視する（ファイルも作らない）", async (t) => {
        const file = setup(t)

        await recordClaudeCreditUsage(Number.NaN)
        await recordClaudeCreditUsage(Number.POSITIVE_INFINITY)
        await recordClaudeCreditUsage(-1)

        await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" })
    })

    it("同時に呼ばれても取りこぼさず、呼んだ順に積み上がる", async (t) => {
        const file = setup(t)

        await Promise.all([
            recordClaudeCreditUsage(100),
            recordClaudeCreditUsage(300),
            recordClaudeCreditUsage(600),
        ])

        const saved = await readLedger(file)
        assert.equal(saved.usedTotalMinor, 500)
        assert.equal(saved.lastObservedMinor, 600)
    })

    it("記録ファイルが壊れていても空から始める", async (t) => {
        const file = setup(t)
        await writeFile(file, "not json")

        await recordClaudeCreditUsage(700)

        assert.equal((await readLedger(file)).lastObservedMinor, 700)
    })
})

describe("correctClaudeCreditBalance", () => {
    it("補正した時点の使用額の累計と、その日を起点として残す", async (t) => {
        const file = setup(t)
        await recordClaudeCreditUsage(1_000)
        await recordClaudeCreditUsage(1_400)

        const before = Date.now()
        await correctClaudeCreditBalance(6_818)

        const { correction } = await readLedger(file)
        assert.equal(correction?.balanceMinor, 6_818)
        assert.equal(correction?.usedTotalMinor, 400)
        assert.match(correction?.date ?? "", /^\d{4}-\d{2}-\d{2}$/)
        assert.ok(Date.parse(correction?.at ?? "") >= before)
    })
})

describe("describeLedger: 有効期限", () => {
    it("購入日から1年たった当日に期限切れになる（前日までは有効）", () => {
        const purchases = [purchase("2025-09-19", 10_000)]

        const lastDay = describeLedger(state({ purchases }), localNoon(2026, 9, 18))
        const expiry = describeLedger(state({ purchases }), localNoon(2026, 9, 19))

        assert.equal(lastDay.purchases[0].expiresOn, "2026-09-19")
        assert.equal(lastDay.purchases[0].expired, false)
        assert.equal(lastDay.activePurchasedText, "$100.00")
        assert.equal(expiry.purchases[0].expired, true)
        assert.equal(expiry.activePurchasedText, "$0.00")
    })

    it("有効な購入だけを合計し、期限切れは含めない", () => {
        const purchases = [
            purchase("2025-01-10", 5_000), // 期限切れ
            purchase("2025-10-01", 2_000),
            purchase("2026-03-01", 3_000),
        ]

        const view = describeLedger(state({ purchases }), localNoon(2026, 9, 19))

        assert.equal(view.activePurchasedText, "$50.00")
        assert.deepEqual(
            view.purchases.map((item) => item.expired),
            [false, false, true]
        )
    })

    it("うるう日の購入も、翌年の3月1日までには期限切れになる", () => {
        const purchases = [purchase("2024-02-29", 1_000)]

        const before = describeLedger(state({ purchases }), localNoon(2025, 2, 28))
        const after = describeLedger(state({ purchases }), localNoon(2025, 3, 1))

        assert.equal(before.purchases[0].expired, false)
        assert.equal(after.purchases[0].expired, true)
    })

    it("購入が無ければ購入額は出さない", () => {
        assert.equal(describeLedger(state(), localNoon(2026, 9, 19)).activePurchasedText, null)
    })

    it("購入は新しい日付の順に並べ、同じ日は記録の新しい順にする", () => {
        const purchases = [
            purchase("2026-01-01", 100, "old"),
            purchase("2026-03-01", 100, "same-early", "2026-03-01T01:00:00.000Z"),
            purchase("2026-03-01", 100, "same-late", "2026-03-01T09:00:00.000Z"),
        ]

        const view = describeLedger(state({ purchases }), localNoon(2026, 9, 19))

        assert.deepEqual(view.purchases.map((item) => item.id), ["same-late", "same-early", "old"])
    })
})

describe("describeLedger: 推定残高", () => {
    const now = localNoon(2026, 9, 19)
    const correction = { balanceMinor: 6_818, at: "2026-09-10T03:00:00.000Z", date: "2026-09-10", usedTotalMinor: 1_000 }

    it("補正していなければ残高は出さない", () => {
        const view = describeLedger(state({ purchases: [purchase("2026-09-01", 5_000)], usedTotalMinor: 900 }), now)

        assert.equal(view.balanceMinor, null)
        assert.equal(view.balanceText, null)
        assert.equal(view.correctedAt, null)
        assert.equal(view.correctedBalanceText, null)
    })

    it("補正した残高から、補正後の使用額を引く", () => {
        const view = describeLedger(state({ correction, usedTotalMinor: 1_500 }), now)

        assert.equal(view.balanceMinor, 6_318)
        assert.equal(view.balanceText, "$63.18")
        assert.equal(view.correctedAt, correction.at)
        assert.equal(view.correctedBalanceText, "$68.18")
    })

    it("補正した日より後の購入だけを足す（補正日当日の購入は残高に含まれている）", () => {
        const purchases = [
            purchase("2026-09-09", 1_000), // 補正より前
            purchase("2026-09-10", 2_000), // 補正日当日
            purchase("2026-09-11", 4_000), // 補正より後
        ]

        const view = describeLedger(state({ purchases, correction, usedTotalMinor: 1_000 }), now)

        assert.equal(view.balanceMinor, 6_818 + 4_000)
    })

    it("期限切れの購入も、補正より後のものは残高へ足している（期限切れの差し引きは再現しない）", () => {
        // 購入日から1年以内の購入だけを合計する「購入総額」とは別扱い
        const purchases = [purchase("2025-09-11", 4_000)]

        const view = describeLedger(state({ purchases, correction: { ...correction, date: "2025-09-10" }, usedTotalMinor: 1_000 }), now)

        assert.equal(view.activePurchasedText, "$0.00")
        assert.equal(view.balanceMinor, 6_818 + 4_000)
    })

    it("使用額が残高を超えたら0で止める（負にはしない）", () => {
        const view = describeLedger(state({ correction, usedTotalMinor: 1_000 + 7_000 }), now)

        assert.equal(view.balanceMinor, 0)
        assert.equal(view.balanceText, "$0.00")
    })

    it("累計が補正時点より小さくなっても、使用額は負にせず残高を増やさない", () => {
        const view = describeLedger(state({ correction, usedTotalMinor: 200 }), now)

        assert.equal(view.balanceMinor, 6_818)
    })
})

describe("isValidDateKey", () => {
    it("実在する YYYY-MM-DD だけを受け付ける", () => {
        assert.equal(isValidDateKey("2026-09-19"), true)
        assert.equal(isValidDateKey("2024-02-29"), true)
        assert.equal(isValidDateKey("2025-02-29"), false)
        assert.equal(isValidDateKey("2026-02-30"), false)
        assert.equal(isValidDateKey("2026-13-01"), false)
        assert.equal(isValidDateKey("2026-9-19"), false)
        assert.equal(isValidDateKey("2026-09-19T00:00:00Z"), false)
        assert.equal(isValidDateKey(""), false)
    })
})

describe("toMinorUnits", () => {
    it("USDをセントへ丸めて変換する", () => {
        assert.equal(toMinorUnits(12.34), 1_234)
        assert.equal(toMinorUnits(0), 0)
        assert.equal(toMinorUnits(0.1 + 0.2), 30)
        assert.equal(toMinorUnits(1_000_000), 100_000_000)
    })

    it("負の値・上限超え・数値でない値は受け付けない", () => {
        assert.equal(toMinorUnits(-0.01), null)
        assert.equal(toMinorUnits(1_000_000.01), null)
        assert.equal(toMinorUnits(Number.NaN), null)
        assert.equal(toMinorUnits(Number.POSITIVE_INFINITY), null)
    })
})

describe("getReservedPercent", () => {
    function credit(overrides: Partial<AiProviderCredit> = {}, monthly: Partial<NonNullable<AiProviderCredit["monthly"]>> | null = {}): AiProviderCredit {
        return {
            valueText: "",
            usedPercent: 30,
            detailText: null,
            resetsAt: null,
            monthly: monthly ? { usedMinor: 6_000, limitMinor: 20_000, currency: "USD", decimals: 2, ...monthly } : undefined,
            ...overrides,
        }
    }

    it("推定残高を月の上限に対する割合にする", () => {
        assert.equal(getReservedPercent(credit(), 4_000), 20)
    })

    it("小数第1位まで丸める", () => {
        assert.equal(getReservedPercent(credit(), 3_333), 16.7)
    })

    it("使用済みの右隣に描くため、上限までの残りを超える分は切る", () => {
        // 使用済み30%なので、残高が上限の80%分あっても塗れるのは残りの70%まで
        assert.equal(getReservedPercent(credit(), 16_000), 70)
        assert.equal(getReservedPercent(credit({ usedPercent: 100 }), 4_000), undefined)
    })

    it("残高が無い・ゼロ・負のときは出さない", () => {
        assert.equal(getReservedPercent(credit(), null), undefined)
        assert.equal(getReservedPercent(credit(), 0), undefined)
        assert.equal(getReservedPercent(credit(), -1), undefined)
    })

    it("使用率・月の上限が分からないときは出さない", () => {
        assert.equal(getReservedPercent(credit({ usedPercent: null }), 4_000), undefined)
        assert.equal(getReservedPercent(credit({}, null), 4_000), undefined)
        assert.equal(getReservedPercent(credit({}, { limitMinor: null }), 4_000), undefined)
        assert.equal(getReservedPercent(credit({}, { limitMinor: 0 }), 4_000), undefined)
    })

    it("台帳と通貨・桁数が違うときは換算できないので出さない", () => {
        assert.equal(getReservedPercent(credit({}, { currency: "JPY" }), 4_000), undefined)
        assert.equal(getReservedPercent(credit({}, { decimals: 0 }), 4_000), undefined)
    })
})

describe("applyClaudeCreditLedger", () => {
    it("Claudeが含まれないスナップショットはそのまま返す", async (t) => {
        setup(t)
        const snapshot = makeSnapshot([makeProvider("chatgpt", [])])

        assert.equal(await applyClaudeCreditLedger(snapshot), snapshot)
    })

    it("提供元の取得結果（キャッシュ）は書き換えず、コピーへ台帳の値を載せる", async (t) => {
        const file = setup(t)
        await writeFile(
            file,
            JSON.stringify(
                state({
                    purchases: [purchase("2099-01-01", 5_000)],
                    correction: { balanceMinor: 4_000, at: "2026-09-10T00:00:00.000Z", date: "2026-09-10", usedTotalMinor: 0 },
                })
            )
        )
        const credit: AiProviderCredit = {
            valueText: "使用 $60.00",
            usedPercent: 30,
            detailText: "上限 $200.00",
            resetsAt: null,
            monthly: { usedMinor: 6_000, limitMinor: 20_000, currency: "USD", decimals: 2 },
        }
        const snapshot = makeSnapshot([makeProvider("claude", [], { credit })])

        const result = await applyClaudeCreditLedger(snapshot)
        const applied = result.providers[0].credit

        assert.equal(applied?.valueText, "残り $90.00")
        assert.equal(applied?.detailText, "上限 $200.00 · 購入 $50.00（有効分）")
        assert.equal(applied?.reservedPercent, 45)
        assert.equal(snapshot.providers[0].credit, credit)
        assert.equal(credit.valueText, "使用 $60.00")
        assert.equal(credit.ledger, undefined)
    })

    it("補正していなければ提供元の表示を残す。取得に失敗した回も台帳だけは出す", async (t) => {
        setup(t)
        const failed = makeSnapshot([makeProvider("claude", [], { status: "error" })])

        const result = await applyClaudeCreditLedger(failed)

        assert.equal(result.providers[0].credit?.valueText, "未記録")
        assert.equal(result.providers[0].credit?.usedPercent, null)
        assert.deepEqual(result.providers[0].credit?.ledger?.purchases, [])
    })
})
