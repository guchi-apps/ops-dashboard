import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEFAULT_SCHEDULE, describeSchedule, latestSlot, nextSlot, readSchedule } from "@/lib/ai-app-usage/price-watch/schedule"

/** JSTの日時（UTC+9）をミリ秒で */
const jst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 9, min)

describe("readSchedule", () => {
    it("既定は毎週月曜05:00（Asia/Tokyo）", () => {
        assert.deepEqual(readSchedule({}), DEFAULT_SCHEDULE)
        assert.equal(describeSchedule(DEFAULT_SCHEDULE), "毎週月曜 05:00（Asia/Tokyo）")
    })

    it("環境変数で曜日・時・タイムゾーンを変えられ、不正な値は既定へ戻す", () => {
        assert.deepEqual(readSchedule({ MODEL_PRICE_WATCH_DAY: "3", MODEL_PRICE_WATCH_HOUR: "22", MODEL_PRICE_WATCH_TZ: "UTC" }), {
            day: 3,
            hour: 22,
            timeZone: "UTC",
        })
        assert.deepEqual(readSchedule({ MODEL_PRICE_WATCH_DAY: "9", MODEL_PRICE_WATCH_HOUR: "x", MODEL_PRICE_WATCH_TZ: "Nowhere/City" }), DEFAULT_SCHEDULE)
    })
})

describe("latestSlot / nextSlot", () => {
    // 2026-10-05 は月曜
    it("月曜05:00（JST）を過ぎていれば、その日が直近の予定時刻", () => {
        assert.equal(latestSlot(jst(2026, 10, 5, 5, 1), DEFAULT_SCHEDULE), jst(2026, 10, 5, 5))
        assert.equal(latestSlot(jst(2026, 10, 7, 12), DEFAULT_SCHEDULE), jst(2026, 10, 5, 5))
    })

    it("05:00より前なら、前の週の月曜が直近", () => {
        assert.equal(latestSlot(jst(2026, 10, 5, 4, 59), DEFAULT_SCHEDULE), jst(2026, 9, 28, 5))
    })

    it("次回の予定時刻は、いまより後の最初の月曜05:00", () => {
        assert.equal(nextSlot(jst(2026, 10, 5, 5, 1), DEFAULT_SCHEDULE), jst(2026, 10, 12, 5))
        assert.equal(nextSlot(jst(2026, 10, 5, 4), DEFAULT_SCHEDULE), jst(2026, 10, 5, 5))
    })

    it("UTC日付と現地日付がずれる時間帯（JSTの朝）でも曜日を現地で数える", () => {
        // 2026-10-04(日) 20:30 UTC = 2026-10-05(月) 05:30 JST
        assert.equal(latestSlot(Date.UTC(2026, 9, 4, 20, 30), DEFAULT_SCHEDULE), jst(2026, 10, 5, 5))
    })
})
