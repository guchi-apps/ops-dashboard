import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { commitDeliveredAlerts, evaluateUsageAlerts } from "@/lib/ai-usage/alerts"
import {
    DAY,
    FIVE_HOUR_SECONDS,
    HOUR,
    WEEK_SECONDS,
    makeProvider,
    makeSnapshot,
    makeWindow,
} from "@/lib/ai-usage/test-support"

const NOW = Date.UTC(2026, 8, 18, 3, 0, 0)
const RESET = new Date(NOW + 2 * HOUR).toISOString()
const EMPTY = { windows: {} }

function fiveHour(usedPercent: number, resetsAt = RESET) {
    return makeWindow({ label: "5時間", usedPercent, resetsAt, windowSeconds: FIVE_HOUR_SECONDS })
}

function weekly(usedPercent: number, resetsAt = RESET, note?: string) {
    return makeWindow({ usedPercent, resetsAt, windowSeconds: WEEK_SECONDS, note })
}

describe("evaluateUsageAlerts: 通知する閾値", () => {
    it("Claudeの5時間枠は90%未満なら送らず、90%で警告する", () => {
        const below = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(89.9)])]), EMPTY, NOW)
        assert.equal(below.alerts.length, 0)

        const at = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(90)])]), EMPTY, NOW)
        assert.equal(at.alerts.length, 1)
        assert.equal(at.alerts[0].level, "warn")
    })

    it("週間枠は95%未満なら送らず、95%で警告する（Claude・ChatGPTとも）", () => {
        for (const id of ["claude", "chatgpt"] as const) {
            const below = evaluateUsageAlerts(makeSnapshot([makeProvider(id, [weekly(94.9)])]), EMPTY, NOW)
            assert.equal(below.alerts.length, 0, `${id} 94.9%`)

            const at = evaluateUsageAlerts(makeSnapshot([makeProvider(id, [weekly(95)])]), EMPTY, NOW)
            assert.equal(at.alerts.length, 1, `${id} 95%`)
            assert.equal(at.alerts[0].level, "warn")
        }
    })

    it("100%に達したら「上限に達しました」の通知になる", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), EMPTY, NOW)

        assert.equal(result.alerts[0].level, "full")
        assert.match(result.alerts[0].message.title, /上限に達しました/)
    })

    it("ChatGPTの5時間枠は100%でも対象外", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [fiveHour(100)])]), EMPTY, NOW)

        assert.equal(result.alerts.length, 0)
    })

    it("5時間でも週間でもない長さの枠は対象外", () => {
        const oneDay = makeWindow({ usedPercent: 100, resetsAt: RESET, windowSeconds: 24 * 60 * 60 })
        const fiveDays = makeWindow({ usedPercent: 100, resetsAt: RESET, windowSeconds: 5 * 24 * 60 * 60 })

        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [oneDay, fiveDays])]), EMPTY, NOW)

        assert.equal(result.alerts.length, 0)
    })

    it("週間の下限は6日で、それ以上の長さなら週間枠として扱う", () => {
        const sixDays = makeWindow({ usedPercent: 95, resetsAt: RESET, windowSeconds: 6 * 24 * 60 * 60 })
        const justUnder = makeWindow({ usedPercent: 95, resetsAt: RESET, windowSeconds: 6 * 24 * 60 * 60 - 1 })

        assert.equal(evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [sixDays])]), EMPTY, NOW).alerts.length, 1)
        assert.equal(evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [justUnder])]), EMPTY, NOW).alerts.length, 0)
    })

    it("リセット時刻・枠の長さが分からない枠は判定しない", () => {
        const windows = [
            makeWindow({ usedPercent: 100, resetsAt: null }),
            makeWindow({ usedPercent: 100, windowSeconds: null }),
            makeWindow({ usedPercent: 100, resetsAt: "not-a-date" }),
        ]

        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", windows)]), EMPTY, NOW)

        assert.equal(result.alerts.length, 0)
        assert.deepEqual(result.state, EMPTY)
    })

    it("取得に失敗した提供元（0%扱いになっている）は判定しない", () => {
        const failed = makeProvider("claude", [fiveHour(100)], { status: "error" })
        const unconfigured = makeProvider("chatgpt", [weekly(100)], { status: "unconfigured" })

        const result = evaluateUsageAlerts(makeSnapshot([failed, unconfigured]), EMPTY, NOW)

        assert.equal(result.alerts.length, 0)
    })
})

describe("evaluateUsageAlerts: 同じ枠へ重ねて送らない", () => {
    it("同じ枠・同じ段階は1回だけ送る", () => {
        const snapshot = makeSnapshot([makeProvider("claude", [fiveHour(92)])])

        const first = evaluateUsageAlerts(snapshot, EMPTY, NOW)
        const second = evaluateUsageAlerts(snapshot, first.state, NOW)

        assert.equal(first.alerts.length, 1)
        assert.equal(second.alerts.length, 0)
    })

    it("警告のあとに100%へ達したら、上限の通知をもう1回送る", () => {
        const warn = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(92)])]), EMPTY, NOW)
        const full = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), warn.state, NOW)
        const again = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), full.state, NOW)

        assert.equal(full.alerts.length, 1)
        assert.equal(full.alerts[0].level, "full")
        assert.equal(again.alerts.length, 0)
    })

    it("上限の通知のあとに使用率が下がっても、警告を送り直さない", () => {
        const full = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), EMPTY, NOW)
        const dropped = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(93)])]), full.state, NOW)

        assert.equal(dropped.alerts.length, 0)
    })

    it("最初の判定で既に100%なら、警告を飛ばして上限の通知だけを送る", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), EMPTY, NOW)

        assert.deepEqual(result.alerts.map((alert) => alert.level), ["full"])
    })

    it("リセット時刻が数秒ずれるだけ（ChatGPT）なら同じ枠として扱い、再送しない", () => {
        const first = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96)])]), EMPTY, NOW)
        const shifted = new Date(Date.parse(RESET) + 7_000).toISOString()
        const second = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96, shifted)])]), first.state, NOW)

        assert.equal(second.alerts.length, 0)
    })

    it("リセット時刻が枠の半分より先へ進んだら別の枠として扱い、また送る", () => {
        const first = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96)])]), EMPTY, NOW)

        // 半分ちょうどは「進んだ」側（境界を含めない）。1ミリ秒手前は同じ枠のまま
        const half = (WEEK_SECONDS * 1000) / 2
        const justBefore = new Date(Date.parse(RESET) + half - 1).toISOString()
        const atHalf = new Date(Date.parse(RESET) + half).toISOString()

        const same = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96, justBefore)])]), first.state, NOW)
        const next = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96, atHalf)])]), first.state, NOW)

        assert.equal(same.alerts.length, 0)
        assert.equal(next.alerts.length, 1)
    })

    it("リセット時刻が枠の半分より手前へ戻った場合も別の枠として扱う", () => {
        const first = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96)])]), EMPTY, NOW)
        const earlier = new Date(Date.parse(RESET) - 4 * DAY).toISOString()

        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96, earlier)])]), first.state, NOW)

        assert.equal(result.alerts.length, 1)
    })

    it("同じ長さの週間枠でも、補足（Opusなど）が違えば別の枠として数える", () => {
        const snapshot = makeSnapshot([
            makeProvider("claude", [weekly(96), weekly(96, RESET, "Opus"), weekly(96, RESET, "Sonnet")]),
        ])

        const first = evaluateUsageAlerts(snapshot, EMPTY, NOW)
        const second = evaluateUsageAlerts(snapshot, first.state, NOW)

        assert.equal(first.alerts.length, 3)
        assert.equal(new Set(first.alerts.map((alert) => alert.key)).size, 3)
        assert.equal(second.alerts.length, 0)
    })

    it("提供元が違えば同じ長さの枠でも別の枠として数える", () => {
        const snapshot = makeSnapshot([
            makeProvider("claude", [weekly(96)]),
            makeProvider("chatgpt", [weekly(96)]),
        ])

        assert.equal(evaluateUsageAlerts(snapshot, EMPTY, NOW).alerts.length, 2)
    })

    it("渡した記録は書き換えず、更新後の記録を別に返す", () => {
        const state = { windows: {} }
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(92)])]), state, NOW)

        assert.deepEqual(state, { windows: {} })
        assert.deepEqual(Object.values(result.state.windows), [{ resetsAt: RESET, level: "warn" }])
    })

    it("判定に出てこなかった枠の記録は次の記録へ引き継ぐ", () => {
        const first = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96)])]), EMPTY, NOW)
        const second = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(50)])]), first.state, NOW)

        assert.deepEqual(second.state, first.state)
    })
})

describe("commitDeliveredAlerts: 届いた通知だけを記録する（#297）", () => {
    it("どの端末にも届かなかった通知は記録せず、次の判定で同じ通知をもう一度送る", () => {
        const snapshot = makeSnapshot([makeProvider("claude", [fiveHour(92)])])
        const first = evaluateUsageAlerts(snapshot, EMPTY, NOW)
        const committed = commitDeliveredAlerts(EMPTY, first.state, [])

        assert.deepEqual(committed, EMPTY)
        const retry = evaluateUsageAlerts(snapshot, committed, NOW + 5 * 60 * 1000)
        assert.equal(retry.alerts.length, 1)
        assert.equal(retry.alerts[0].level, "warn")
    })

    it("届いた通知は記録し、同じ枠・同じ段階を送り直さない", () => {
        const snapshot = makeSnapshot([makeProvider("claude", [fiveHour(92)])])
        const first = evaluateUsageAlerts(snapshot, EMPTY, NOW)
        const committed = commitDeliveredAlerts(EMPTY, first.state, first.alerts.map((alert) => alert.key))

        assert.deepEqual(committed, first.state)
        assert.equal(evaluateUsageAlerts(snapshot, committed, NOW).alerts.length, 0)
    })

    it("同じ回に複数送ったときは、届いた枠だけを記録する", () => {
        const snapshot = makeSnapshot([
            makeProvider("claude", [fiveHour(92)]),
            makeProvider("chatgpt", [weekly(96)]),
        ])
        const first = evaluateUsageAlerts(snapshot, EMPTY, NOW)
        const chatgptKey = first.alerts.find((alert) => alert.key.startsWith("chatgpt:"))!.key
        const committed = commitDeliveredAlerts(EMPTY, first.state, [chatgptKey])

        const retry = evaluateUsageAlerts(snapshot, committed, NOW)
        assert.deepEqual(retry.alerts.map((alert) => alert.key.split(":")[0]), ["claude"])
    })

    it("警告を送ったあと上限の通知が届かなければ、警告の記録を残したまま上限だけを送り直す", () => {
        const warned = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(92)])]), EMPTY, NOW).state
        const full = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), warned, NOW)
        const committed = commitDeliveredAlerts(warned, full.state, [])

        assert.deepEqual(committed, warned)
        const retry = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(100)])]), committed, NOW)
        assert.deepEqual(retry.alerts.map((alert) => alert.level), ["full"])
    })
})

describe("evaluateUsageAlerts: 通知の文面", () => {
    it("警告は枠の名前と閾値、使用率、リセットまでの時間を出し、枠ごとのtagを付ける", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(91.4)])]), EMPTY, NOW)
        const { key, message } = result.alerts[0]

        assert.equal(message.title, "Claude 5時間枠が90%を超えました")
        assert.match(message.body, /^使用率 91%。あと2時間0分でリセット/)
        assert.equal(message.tag, `ai-usage:${key}`)
        assert.equal(message.url, "/?tab=usage")
    })

    it("補足のある枠は名前の後ろに括弧で添える", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [weekly(97, RESET, "Opus")])]), EMPTY, NOW)

        assert.equal(result.alerts[0].message.title, "Claude 週間枠（Opus）が95%を超えました")
    })

    it("リセット時刻が別の日なら、日付も添える（日本時間）", () => {
        const tomorrow = new Date(NOW + DAY).toISOString()
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("chatgpt", [weekly(96, tomorrow)])]), EMPTY, NOW)

        // NOW は日本時間で 9/18 12:00、リセットは 9/19 12:00
        assert.match(result.alerts[0].message.body, /（9\/19 12:00）$/)
    })

    it("リセット時刻が同じ日（日本時間）なら時刻だけを添える", () => {
        const result = evaluateUsageAlerts(makeSnapshot([makeProvider("claude", [fiveHour(92)])]), EMPTY, NOW)

        // NOW は日本時間で 12:00、リセットは 14:00
        assert.match(result.alerts[0].message.body, /（14:00）$/)
    })
})
