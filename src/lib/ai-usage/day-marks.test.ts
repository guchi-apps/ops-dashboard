import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import { attachDayMarks } from "@/lib/ai-usage/day-marks"
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
import type { AiUsageDayMark, AiUsageWindow } from "@/types/ai-usage"

/** 週間枠は 2026-09-13 00:00Z 〜 09-20 00:00Z。1日目の終わりは 09-14 00:00Z */
const RESET = Date.UTC(2026, 8, 20)
const START = RESET - 7 * DAY
const DAY1 = START + DAY
const DAY2 = START + 2 * DAY

function weekly(usedPercent: number, overrides: Partial<AiUsageWindow> = {}) {
    return makeWindow({
        usedPercent,
        resetsAt: new Date(RESET).toISOString(),
        windowSeconds: WEEK_SECONDS,
        ...overrides,
    })
}

/** 観測を1回反映し、週間枠（先頭の枠）の区切りを返す */
async function observe(now: number, usedPercent: number, overrides: Partial<AiUsageWindow> = {}) {
    const snapshot = makeSnapshot([makeProvider("claude", [weekly(usedPercent, overrides)])], now)
    const result = await attachDayMarks(snapshot, now)
    return result.providers[0].windows[0].dayMarks
}

function summary(marks: AiUsageDayMark[] | undefined) {
    return marks?.map((mark) => [mark.day, mark.usedPercent])
}

function setup(t: TestContext) {
    return redirectStateFile(t, "AI_USAGE_DAYS_PATH")
}

describe("attachDayMarks: 6時間ルール", () => {
    it("区切りの手前6時間以内の観測があれば、その値を区切りの値として確定する", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        const marks = await observe(DAY1 + HOUR, 25)

        assert.deepEqual(marks, [
            {
                day: 1,
                usedPercent: 10,
                at: new Date(DAY1).toISOString(),
                observedAt: new Date(DAY1 - HOUR).toISOString(),
            },
        ])
    })

    it("区切りのちょうど6時間前の観測までは使う", async (t) => {
        setup(t)

        await observe(DAY1 - 6 * HOUR, 10)
        const marks = await observe(DAY1 + HOUR, 25)

        assert.deepEqual(summary(marks), [[1, 10]])
    })

    it("区切りの6時間と1ミリ秒前の観測は古すぎるので、線を出さない", async (t) => {
        setup(t)

        await observe(DAY1 - 6 * HOUR - 1, 10)
        const marks = await observe(DAY1 + HOUR, 25)

        assert.deepEqual(marks, [])
    })

    it("区切りちょうどの時刻の観測は、その区切りの値として使える", async (t) => {
        setup(t)

        await observe(DAY1, 12)
        const marks = await observe(DAY1 + HOUR, 25)

        assert.deepEqual(summary(marks), [[1, 12]])
    })

    it("区切りより後に観測した値は、その区切りの値には使わない", async (t) => {
        setup(t)

        await observe(DAY1 + MINUTE, 12)
        const marks = await observe(DAY1 + 2 * MINUTE, 13)

        assert.deepEqual(marks, [])
    })

    it("まだ過ぎていない区切りは確定しない", async (t) => {
        setup(t)

        await observe(DAY1 - 2 * HOUR, 10)
        const marks = await observe(DAY1 - HOUR, 11)

        assert.deepEqual(marks, [])
    })

    it("観測が空いて複数の区切りを跨いだときは、直前の観測に近い区切りだけを確定する", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        // 1日目の終わりは1時間後、2日目の終わりは25時間後。2日目は間が空きすぎている
        const marks = await observe(DAY2 + HOUR, 40)

        assert.deepEqual(summary(marks), [[1, 10]])
    })

    it("丸1日開かなかった日は線を出さず、確定済みの区切りは残す", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        await observe(DAY1 + HOUR, 12) // 1日目を確定
        // 2日目の終わりを跨いで、翌日の昼まで観測が無い
        const marks = await observe(DAY2 + 12 * HOUR, 50)

        assert.deepEqual(summary(marks), [[1, 10]])
    })

    it("同じ区切りを二重には確定せず、日の順に並ぶ", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        await observe(DAY1 + HOUR, 12)
        await observe(DAY2 - HOUR, 20)
        await observe(DAY2 + HOUR, 22)
        const marks = await observe(DAY2 + 2 * HOUR, 23)

        assert.deepEqual(summary(marks), [
            [1, 10],
            [2, 20],
        ])
    })

    it("枠の終わり（7日目）には区切りを作らない。区切りは1〜6日目の終わりだけ", async (t) => {
        setup(t)

        await observe(RESET - HOUR, 90)
        const marks = await observe(RESET + HOUR, 5, { resetsAt: new Date(RESET).toISOString() })

        assert.equal(marks?.some((mark) => mark.day === 7), false)
    })
})

describe("attachDayMarks: 対象の枠", () => {
    it("1日以下の枠（5時間枠・ちょうど24時間）には区切りを載せない", async (t) => {
        setup(t)
        const windows = [
            makeWindow({ label: "5時間", windowSeconds: FIVE_HOUR_SECONDS, resetsAt: new Date(RESET).toISOString() }),
            makeWindow({ label: "1日", windowSeconds: 24 * 60 * 60, resetsAt: new Date(RESET).toISOString() }),
        ]

        const result = await attachDayMarks(makeSnapshot([makeProvider("claude", windows)]), DAY1)

        assert.equal(result.providers[0].windows[0].dayMarks, undefined)
        assert.equal(result.providers[0].windows[1].dayMarks, undefined)
    })

    it("リセット時刻・枠の長さが分からない枠は、そのまま返す", async (t) => {
        setup(t)
        const windows = [
            weekly(10, { resetsAt: null }),
            weekly(10, { windowSeconds: null }),
            weekly(10, { resetsAt: "not-a-date" }),
        ]

        const result = await attachDayMarks(makeSnapshot([makeProvider("claude", windows)]), DAY1)

        assert.deepEqual(result.providers[0].windows, windows)
    })

    it("取得に失敗した提供元は記録せず（0%を『使わなかった日』にしない）、そのまま返す", async (t) => {
        const file = setup(t)
        const provider = makeProvider("claude", [weekly(0)], { status: "error" })

        const result = await attachDayMarks(makeSnapshot([provider]), DAY1)

        assert.deepEqual(result.providers[0], provider)
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { windows: {} })
    })

    it("同じ長さでも補足（Opusなど）の違う枠は別々に記録する", async (t) => {
        setup(t)
        const at = (now: number, main: number, opus: number) =>
            attachDayMarks(
                makeSnapshot([makeProvider("claude", [weekly(main), weekly(opus, { note: "Opus" })])], now),
                now
            )

        await at(DAY1 - HOUR, 10, 3)
        const result = await at(DAY1 + HOUR, 25, 8)

        assert.deepEqual(summary(result.providers[0].windows[0].dayMarks), [[1, 10]])
        assert.deepEqual(summary(result.providers[0].windows[1].dayMarks), [[1, 3]])
    })

    it("提供元が違えば記録も別になる", async (t) => {
        setup(t)
        const at = (now: number, claude: number, chatgpt: number) =>
            attachDayMarks(
                makeSnapshot(
                    [makeProvider("claude", [weekly(claude)]), makeProvider("chatgpt", [weekly(chatgpt)])],
                    now
                ),
                now
            )

        await at(DAY1 - HOUR, 10, 70)
        const result = await at(DAY1 + HOUR, 11, 71)

        assert.deepEqual(summary(result.providers[0].windows[0].dayMarks), [[1, 10]])
        assert.deepEqual(summary(result.providers[1].windows[0].dayMarks), [[1, 70]])
    })
})

describe("attachDayMarks: 枠の同定とリセット", () => {
    it("リセット時刻が60秒以内のずれなら同じ枠として、確定済みの区切りを引き継ぐ", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        await observe(DAY1 + HOUR, 12)
        const marks = await observe(DAY1 + 2 * HOUR, 13, { resetsAt: new Date(RESET + 60_000).toISOString() })

        assert.deepEqual(summary(marks), [[1, 10]])
    })

    it("リセット時刻が60秒より大きくずれたら別の枠として、記録を作り直す", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        await observe(DAY1 + HOUR, 12)
        const marks = await observe(DAY1 + 2 * HOUR, 13, { resetsAt: new Date(RESET + 60_001).toISOString() })

        assert.deepEqual(marks, [])
    })

    it("枠の長さが変わったら別の枠として扱う", async (t) => {
        setup(t)

        await observe(DAY1 - HOUR, 10)
        await observe(DAY1 + HOUR, 12)
        const marks = await observe(DAY1 + 2 * HOUR, 13, { windowSeconds: WEEK_SECONDS + 1 })

        assert.deepEqual(marks, [])
    })

    it("リセット直後は線が無い（新しい枠は観測を積み直す）", async (t) => {
        setup(t)
        const nextReset = RESET + 7 * DAY

        await observe(RESET - HOUR, 90)
        const marks = await observe(RESET + HOUR, 2, { resetsAt: new Date(nextReset).toISOString() })

        assert.deepEqual(marks, [])
    })
})

describe("attachDayMarks: 記録の掃除と失敗", () => {
    async function keys(file: string) {
        return Object.keys(JSON.parse(await readFile(file, "utf8")).windows)
    }

    it("観測が途絶えた枠は、リセットから30日たつまで残し、それ以降に捨てる", async (t) => {
        const file = setup(t)
        await observe(DAY1 - HOUR, 10)
        assert.deepEqual(await keys(file), ["claude:週間:"])

        const other = makeSnapshot([makeProvider("chatgpt", [])], RESET)
        await attachDayMarks(other, RESET + 30 * DAY - 1)
        assert.deepEqual(await keys(file), ["claude:週間:"])

        await attachDayMarks(other, RESET + 30 * DAY)
        assert.deepEqual(await keys(file), [])
    })

    it("観測中の枠は、リセットから30日を過ぎても捨てない", async (t) => {
        const file = setup(t)

        await observe(RESET + 40 * DAY, 10)

        assert.deepEqual(await keys(file), ["claude:週間:"])
    })

    it("記録ファイルが壊れていても空から始める", async (t) => {
        const file = setup(t)
        await writeFile(file, "not json")

        const marks = await observe(DAY1 - HOUR, 10)

        assert.deepEqual(marks, [])
    })

    it("記録を保存できなくても例外にせず、区切り無しの元のスナップショットを返す", async (t) => {
        const file = setup(t)
        await writeFile(file, "")
        process.env.AI_USAGE_DAYS_PATH = `${file}/nested/state.json`
        t.mock.method(console, "error", () => undefined)
        const snapshot = makeSnapshot([makeProvider("claude", [weekly(10)])], DAY1)

        const result = await attachDayMarks(snapshot, DAY1)

        assert.equal(result, snapshot)
    })
})
