import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import { FULL_USE_PERCENT, applyAiUsageHistory } from "@/lib/ai-usage/history"
import {
    DAY,
    FIVE_HOUR_SECONDS,
    HOUR,
    MINUTE,
    WEEK_SECONDS,
    makeProvider,
    makeSnapshot,
    makeWindow,
    redirectStateFile,
} from "@/lib/ai-usage/test-support"
import type { AiProviderId, AiUsageWindow, AiUsageWindowHistory } from "@/types/ai-usage"

const T0 = Date.UTC(2026, 8, 18, 0, 0, 0)

function window5h(usedPercent: number, resetsAt: number, overrides: Partial<AiUsageWindow> = {}) {
    return makeWindow({
        label: "5時間",
        usedPercent,
        resetsAt: new Date(resetsAt).toISOString(),
        windowSeconds: FIVE_HOUR_SECONDS,
        ...overrides,
    })
}

function weekly(usedPercent: number, resetsAt: number, overrides: Partial<AiUsageWindow> = {}) {
    return makeWindow({
        usedPercent,
        resetsAt: new Date(resetsAt).toISOString(),
        windowSeconds: WEEK_SECONDS,
        ...overrides,
    })
}

/** 観測を1回反映して、その提供元の実績を返す。`fetchedAt` が「いま」になる */
async function observe(
    fetchedAt: number,
    windows: AiUsageWindow[],
    id: AiProviderId = "claude"
): Promise<AiUsageWindowHistory[] | undefined> {
    const snapshot = makeSnapshot([makeProvider(id, windows)], fetchedAt)
    await applyAiUsageHistory(snapshot)
    return snapshot.providers[0].windowHistory
}

function setup(t: TestContext) {
    return redirectStateFile(t, "AI_USAGE_HISTORY_PATH")
}

describe("applyAiUsageHistory: 枠の同定", () => {
    it("リセット時刻が数秒ずれるだけ（ChatGPT）なら同じ枠として1件にまとめ、時刻は最新へ追随する", async (t) => {
        setup(t)
        const reset = T0 + 4 * HOUR

        await observe(T0, [window5h(10, reset)])
        const history = await observe(T0 + 5 * MINUTE, [window5h(20, reset + 7_000)])

        assert.equal(history?.[0].records.length, 1)
        assert.equal(history?.[0].records[0].resetsAt, new Date(reset + 7_000).toISOString())
    })

    it("リセット時刻が枠の半分より先へ進んだら別の枠として積み、半分に届かなければ同じ枠のまま", async (t) => {
        setup(t)
        const reset = T0 + 4 * HOUR
        const half = (FIVE_HOUR_SECONDS * 1000) / 2

        await observe(T0, [window5h(10, reset)])
        const sameWindow = await observe(T0 + MINUTE, [window5h(11, reset + half - 1)])
        assert.equal(sameWindow?.[0].records.length, 1)

        // 直前に記録した枠のリセット時刻は上の観測で half - 1 進んでいる。そこからさらに半分進める
        const next = await observe(T0 + 2 * MINUTE, [window5h(5, reset + half - 1 + half)])
        assert.equal(next?.[0].records.length, 2)
    })

    it("同じ枠の中では使用率の大きいほうを残す（下がった観測で上書きしない）", async (t) => {
        setup(t)
        const reset = T0 + 4 * HOUR

        await observe(T0, [window5h(60, reset)])
        const history = await observe(T0 + MINUTE, [window5h(30, reset)])

        assert.equal(history?.[0].records[0].usedPercent, 60)
    })

    it("使用率は小数第1位までに丸める", async (t) => {
        setup(t)

        const history = await observe(T0, [window5h(33.349, T0 + 4 * HOUR)])

        assert.equal(history?.[0].records[0].usedPercent, 33.3)
    })

    it("週間・週間Opusのように補足が違う枠は別の系列に分ける", async (t) => {
        setup(t)
        const reset = T0 + 3 * DAY

        const history = await observe(T0, [
            weekly(40, reset),
            weekly(10, reset, { note: "Opus" }),
            weekly(20, reset, { note: "Sonnet" }),
        ])

        assert.equal(history?.length, 3)
        assert.deepEqual(
            history?.map((series) => series.note).sort(),
            [undefined, "Opus", "Sonnet"].sort()
        )
    })

    it("提供元が違えば同じ枠の長さでも記録を混ぜない", async (t) => {
        setup(t)
        const reset = T0 + 4 * HOUR

        await observe(T0, [window5h(80, reset)], "claude")
        const chatgpt = await observe(T0, [window5h(10, reset)], "chatgpt")

        assert.equal(chatgpt?.[0].records[0].usedPercent, 10)
    })
})

describe("applyAiUsageHistory: 記録の対象", () => {
    it("取得に失敗した提供元の0%は実績として残さない（ファイルも作らない）", async (t) => {
        const file = setup(t)
        const snapshot = makeSnapshot(
            [makeProvider("claude", [window5h(0, T0 + 4 * HOUR)], { status: "error" })],
            T0
        )

        await applyAiUsageHistory(snapshot)

        assert.equal(snapshot.providers[0].windowHistory, undefined)
        await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" })
    })

    it("リセット時刻・枠の長さが分からない枠は記録しない", async (t) => {
        setup(t)

        const history = await observe(T0, [
            window5h(50, T0, { resetsAt: null }),
            window5h(50, T0 + 4 * HOUR, { windowSeconds: null }),
            window5h(50, T0 + 4 * HOUR, { resetsAt: "not-a-date" }),
        ])

        assert.equal(history, undefined)
    })

    it("記録ファイルが壊れていても空から始めて表示を続ける", async (t) => {
        const file = setup(t)
        await writeFile(file, "{ not json")

        const history = await observe(T0, [window5h(10, T0 + 4 * HOUR)])

        assert.equal(history?.[0].records.length, 1)
    })

    it("記録の保存に失敗しても例外にせず、実績なしのまま返す", async (t) => {
        const file = setup(t)
        // 保存先の親をファイルにして mkdir を失敗させる
        await writeFile(file, "")
        process.env.AI_USAGE_HISTORY_PATH = `${file}/nested/state.json`
        t.mock.method(console, "warn", () => undefined)

        const history = await observe(T0, [window5h(10, T0 + 4 * HOUR)])

        assert.equal(history, undefined)
    })
})

describe("applyAiUsageHistory: 進行中と確定", () => {
    it("リセット時刻を過ぎた枠だけが確定し、平均・使い切り回数の母数になる", async (t) => {
        setup(t)
        const first = T0 + 5 * HOUR

        await observe(T0 + 4 * HOUR + 50 * MINUTE, [window5h(95, first)])
        await observe(T0 + 9 * HOUR, [window5h(30, first + 5 * HOUR)])
        const history = await observe(T0 + 11 * HOUR, [window5h(50, first + 10 * HOUR)])

        const [series] = history ?? []
        assert.deepEqual(
            series.records.map((record) => [record.usedPercent, record.inProgress]),
            [
                [95, false],
                [30, false],
                [50, true],
            ]
        )
        assert.equal(series.completedCount, 2)
        assert.equal(series.averagePercent, 63)
        assert.equal(series.fullCount, 1)
    })

    it("使い切りは90%以上（ちょうど90%を含む）で数える", async (t) => {
        setup(t)
        assert.equal(FULL_USE_PERCENT, 90)
        const first = T0 + 5 * HOUR

        await observe(T0 + 4 * HOUR + 50 * MINUTE, [window5h(FULL_USE_PERCENT - 0.1, first)])
        await observe(T0 + 9 * HOUR + 50 * MINUTE, [window5h(FULL_USE_PERCENT, first + 5 * HOUR)])
        const history = await observe(T0 + 14 * HOUR, [window5h(1, first + 10 * HOUR)])

        assert.equal(history?.[0].completedCount, 2)
        assert.equal(history?.[0].fullCount, 1)
    })

    it("終わった枠がまだ無ければ平均は null", async (t) => {
        setup(t)

        const history = await observe(T0, [window5h(40, T0 + 4 * HOUR)])

        assert.equal(history?.[0].averagePercent, null)
        assert.equal(history?.[0].completedCount, 0)
        assert.equal(history?.[0].fullCount, 0)
    })

    it("リセット時刻とちょうど同時刻の観測では、枠は終わったものとして扱う", async (t) => {
        setup(t)
        const reset = T0 + 4 * HOUR

        await observe(reset - 5 * MINUTE, [window5h(70, reset)])
        // 次の観測はリセット時刻ちょうど。別の枠（半分以上進んだ）へ切り替わる
        const history = await observe(reset, [window5h(0, reset + 5 * HOUR)])

        assert.equal(history?.[0].records[0].inProgress, false)
        assert.equal(history?.[0].records[1].inProgress, true)
    })

    it("表示する本数は短い枠で12本、1日以上の枠で8本に絞り、古いものから落とす", async (t) => {
        setup(t)

        let shortHistory: AiUsageWindowHistory | undefined
        let longHistory: AiUsageWindowHistory | undefined
        for (let index = 0; index < 30; index++) {
            // 枠の半分（2.5時間）以上ずつ進めて、毎回別の枠にする
            const now = T0 + index * 3 * HOUR
            const snapshot = makeSnapshot(
                [
                    makeProvider("claude", [
                        window5h(index, now + HOUR),
                        weekly(index, T0 + (index + 1) * 7 * DAY),
                    ]),
                ],
                now
            )
            await applyAiUsageHistory(snapshot)
            ;[shortHistory, longHistory] = snapshot.providers[0].windowHistory ?? []
        }

        assert.equal(shortHistory?.windowSeconds, FIVE_HOUR_SECONDS)
        assert.equal(shortHistory?.records.length, 12)
        assert.equal(shortHistory?.records.at(-1)?.usedPercent, 29)
        assert.equal(longHistory?.windowSeconds, WEEK_SECONDS)
        assert.equal(longHistory?.records.length, 8)
        assert.equal(longHistory?.records.at(-1)?.usedPercent, 29)
    })

    it("系列は枠の長さの短い順に並ぶ", async (t) => {
        setup(t)

        const history = await observe(T0, [weekly(10, T0 + 3 * DAY), window5h(10, T0 + 4 * HOUR)])

        assert.deepEqual(
            history?.map((series) => series.windowSeconds),
            [FIVE_HOUR_SECONDS, WEEK_SECONDS]
        )
    })
})

describe("applyAiUsageHistory: 観測の粗さ（undersampled）", () => {
    /** 観測から `beforeReset` 手前にリセットされる5時間枠を確定させ、その実績を返す */
    async function undersampledAt(t: TestContext, beforeReset: number) {
        setup(t)
        const reset = T0 + 5 * HOUR

        await observe(reset - beforeReset, [window5h(50, reset)])
        const history = await observe(reset + MINUTE, [window5h(0, reset + 5 * HOUR)])

        return history?.[0].records[0].undersampled
    }

    it("5時間枠は終了のちょうど15分前が最後の観測なら粗くない（許容は枠の5%）", async (t) => {
        assert.equal(await undersampledAt(t, 15 * MINUTE), false)
    })

    it("5時間枠は終了の15分と1ミリ秒前が最後の観測なら粗い", async (t) => {
        assert.equal(await undersampledAt(t, 15 * MINUTE + 1), true)
    })

    it("週間枠の許容は1時間で頭打ちになる", async (t) => {
        setup(t)
        const reset = T0 + 3 * DAY

        await observe(reset - HOUR, [weekly(50, reset)])
        const fine = await observe(reset + MINUTE, [weekly(0, reset + WEEK_SECONDS * 1000)])
        assert.equal(fine?.[0].records[0].undersampled, false)
    })

    it("週間枠で最後の観測が終了の1時間より前なら粗い", async (t) => {
        setup(t)
        const reset = T0 + 3 * DAY

        await observe(reset - HOUR - 1, [weekly(50, reset)])
        const history = await observe(reset + MINUTE, [weekly(0, reset + WEEK_SECONDS * 1000)])

        assert.equal(history?.[0].records[0].undersampled, true)
    })

    it("進行中の枠は粗いとは判定しない", async (t) => {
        setup(t)

        const history = await observe(T0, [window5h(50, T0 + 5 * HOUR)])

        assert.equal(history?.[0].records[0].inProgress, true)
        assert.equal(history?.[0].records[0].undersampled, false)
    })
})

describe("applyAiUsageHistory: 週間枠が5時間枠の何倍か", () => {
    const weekReset = T0 + 5 * DAY

    async function multipleOf(now: number, windows: AiUsageWindow[]) {
        const snapshot = makeSnapshot([makeProvider("claude", windows)], now)
        await applyAiUsageHistory(snapshot)
        return snapshot.providers[0].weeklyMultiple
    }

    it("今週の5時間枠の合計 ÷ 週間使用率で倍率を出す", async (t) => {
        setup(t)
        // 週の開始 = T0 - 2日。5時間枠を3本、それぞれ終了間際まで観測する
        await multipleOf(T0 - DAY, [window5h(60, T0 - DAY + 5 * HOUR), weekly(10, weekReset)])
        await multipleOf(T0 - DAY + 5 * HOUR - MINUTE, [window5h(60, T0 - DAY + 5 * HOUR), weekly(10, weekReset)])
        await multipleOf(T0 - 12 * HOUR, [window5h(40, T0 - 7 * HOUR), weekly(20, weekReset)])
        await multipleOf(T0 - 7 * HOUR - MINUTE, [window5h(40, T0 - 7 * HOUR), weekly(20, weekReset)])
        const result = await multipleOf(T0, [window5h(20, T0 + 5 * HOUR), weekly(40, weekReset)])

        assert.ok(result)
        assert.equal(result.fiveHourCount, 3)
        assert.equal(result.fiveHourTotalPercent, 120)
        assert.equal(result.multiple, 3)
        assert.equal(result.lowerBound, false)
    })

    it("週間使用率が10%未満なら倍率は出さず計測中にする", async (t) => {
        setup(t)
        const result = await multipleOf(T0, [window5h(30, T0 + 5 * HOUR), weekly(5, weekReset)])

        assert.ok(result)
        assert.equal(result.multiple, null)
    })

    it("終了間際に観測できていない5時間枠を含むときは lowerBound を立てる", async (t) => {
        setup(t)
        await multipleOf(T0 - 10 * HOUR, [window5h(30, T0 - 5 * HOUR), weekly(15, weekReset)])
        const result = await multipleOf(T0, [window5h(10, T0 + 5 * HOUR), weekly(20, weekReset)])

        assert.ok(result)
        assert.equal(result.lowerBound, true)
    })

    it("週の開始より前に始まった5時間枠は数えない", async (t) => {
        setup(t)
        const weekStart = weekReset - 7 * DAY
        await multipleOf(weekStart + MINUTE, [window5h(50, weekStart + 2 * HOUR), weekly(1, weekReset)])
        const result = await multipleOf(weekStart + 10 * HOUR, [
            window5h(20, weekStart + 12 * HOUR),
            weekly(20, weekReset),
        ])

        assert.ok(result)
        assert.equal(result.fiveHourCount, 1)
        assert.equal(result.fiveHourTotalPercent, 20)
    })

    it("12本を超える5時間枠も全部足し、記録が週の始まりまで届かないときは lowerBound を立てる", async (t) => {
        setup(t)
        const weekStart = weekReset - 7 * DAY
        // 週の途中から5時間おきに14本。各枠は終了間際まで観測する
        for (let i = 0; i < 14; i++) {
            const reset = weekStart + DAY + (i + 1) * 5 * HOUR
            await multipleOf(reset - MINUTE, [window5h(10, reset), weekly(10, weekReset)])
        }
        const result = await multipleOf(weekStart + 4 * DAY, [window5h(10, weekStart + 4 * DAY + 5 * HOUR), weekly(50, weekReset)])

        assert.ok(result)
        assert.equal(result.fiveHourCount, 15)
        assert.equal(result.fiveHourTotalPercent, 150)
        assert.equal(result.multiple, 3)
        assert.equal(result.lowerBound, false)
    })
})
