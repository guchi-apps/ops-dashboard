import fs from "fs/promises"
import path from "path"
import type { AiUsageDayMark, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/**
 * 1日を超える制限枠（週間など）について、「1日の終わりまでに累計でどこまで使っていたか」を記録する。
 *
 * 画面ではこの値の位置へ細い縦の点線を立て、隣り合う線の間隔でその日に使った量を読ませる（#243）。
 * 提供元は現在の累計使用率しか返さないため、日ごとの内訳は取得のたびに観測を残して導くしかない。
 *
 * **記録が進むのはダッシュボードを開いたときだけ。** 使用状況の取得はリクエスト契機でしか走らず、
 * サーバー側の定期実行は無い。丸1日開かなかった日の区切りは値を確定できないため記録せず、
 * その日は隣の日とまとまって1本の線になる（`github-repo-visibility.ts` と同じ性質の制約）。
 *
 * 保存先はデプロイの削除対象に入らない `.data/` 配下。消えても線が出なくなるだけで、
 * 使用状況そのものの表示には影響しない。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** この長さ以下の枠には日の区切りを出さない（5時間枠など、1日に満たないもの） */
const MIN_WINDOW_SECONDS = 24 * 60 * 60

/** 使われなくなった枠の記録を捨てるまでの猶予 */
const STALE_AFTER_MS = 30 * DAY_MS

/**
 * リセット時刻が同じ枠なら同じ記録を引き継ぐ。
 * 提供元が秒未満の丸め方を変えただけで履歴を捨てないよう、この幅までは同じ枠とみなす。
 */
const SAME_WINDOW_TOLERANCE_MS = 60_000

/**
 * 区切りの値として使ってよい観測の古さ。
 *
 * 区切りの値には「その区切りより前の直近の観測」を使うが、前日の朝の値をその日の終わりの値として
 * 置くと、間に使ったぶんが翌日の量として現れてしまう。これより古い観測しか無い区切りは
 * 確定させず、線を出さない（隣の日とまとまって1本になる）。
 */
const MAX_OBSERVATION_AGE_MS = 6 * 60 * 60 * 1000

interface WindowRecord {
    /** 枠の終わり（ISO 8601）。別の値になったらリセット済みなので記録を作り直す */
    resetsAt: string
    windowSeconds: number
    /** 直近の観測。次に日の区切りを跨いだとき、その区切りの値として確定させる */
    last?: { at: string; usedPercent: number }
    /** 確定した日の区切り */
    marks: AiUsageDayMark[]
}

interface DayMarksState {
    /** キーは `<提供元>:<枠の表示名>:<補足>` */
    windows?: Record<string, WindowRecord>
}

function getStatePath(): string {
    return process.env.AI_USAGE_DAYS_PATH || path.join(process.cwd(), ".data", "ai-usage-days.json")
}

async function readState(): Promise<DayMarksState> {
    try {
        const raw = await fs.readFile(getStatePath(), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return {}
        return parsed as DayMarksState
    } catch {
        return {}
    }
}

async function writeState(state: DayMarksState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/**
 * ファイルへの read-modify-write を直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/** 日の区切りを出せる枠か。リセット時刻と枠の長さが両方分からないと位置を決められない */
function hasDayMarks(
    window: AiUsageWindow
): window is AiUsageWindow & { resetsAt: string; windowSeconds: number } {
    return (
        window.resetsAt !== null &&
        window.windowSeconds !== null &&
        window.windowSeconds > MIN_WINDOW_SECONDS &&
        !Number.isNaN(new Date(window.resetsAt).getTime())
    )
}

function windowKey(providerId: string, window: AiUsageWindow): string {
    return `${providerId}:${window.label}:${window.note ?? ""}`
}

/** 枠の中にある「1日の終わり」の時刻。7日間なら1日目〜6日目の終わりの6つ */
function dayBoundaries(startMs: number, windowSeconds: number): number[] {
    const boundaries: number[] = []
    for (let offset = DAY_MS; offset < windowSeconds * 1000; offset += DAY_MS) {
        boundaries.push(startMs + offset)
    }
    return boundaries
}

function isSameWindow(record: WindowRecord | undefined, resetsAt: string, windowSeconds: number) {
    if (!record || record.windowSeconds !== windowSeconds) return false

    const diff = Math.abs(new Date(record.resetsAt).getTime() - new Date(resetsAt).getTime())
    return Number.isFinite(diff) && diff <= SAME_WINDOW_TOLERANCE_MS
}

/**
 * 今回の観測を記録に取り込む。
 * 過ぎた区切りのうち「直前の観測がその区切りの手前にあり、かつ十分に新しい」ものだけを確定させ、
 * 観測しないまま過ぎてしまった区切りは記録しない（線を出さない）。
 */
function advance(record: WindowRecord, usedPercent: number, now: number): WindowRecord {
    const endMs = new Date(record.resetsAt).getTime()
    const startMs = endMs - record.windowSeconds * 1000
    const marks = [...record.marks]
    const last = record.last
    const lastMs = last ? new Date(last.at).getTime() : Number.NaN

    if (last && !Number.isNaN(lastMs)) {
        dayBoundaries(startMs, record.windowSeconds).forEach((boundaryMs, index) => {
            const day = index + 1
            if (boundaryMs > now) return
            if (lastMs > boundaryMs) return
            if (boundaryMs - lastMs > MAX_OBSERVATION_AGE_MS) return
            if (marks.some((mark) => mark.day === day)) return

            marks.push({
                day,
                usedPercent: last.usedPercent,
                at: new Date(boundaryMs).toISOString(),
                observedAt: last.at,
            })
        })
    }

    return {
        ...record,
        last: { at: new Date(now).toISOString(), usedPercent },
        marks: marks.sort((a, b) => a.day - b.day),
    }
}

/** 今回観測しなかった枠は、リセットからしばらく経っていれば捨てる */
function prune(
    windows: Record<string, WindowRecord>,
    seen: Set<string>,
    now: number
): Record<string, WindowRecord> {
    const kept: Record<string, WindowRecord> = {}

    for (const [key, record] of Object.entries(windows)) {
        if (seen.has(key)) {
            kept[key] = record
            continue
        }

        const endMs = new Date(record.resetsAt).getTime()
        if (!Number.isNaN(endMs) && now - endMs < STALE_AFTER_MS) kept[key] = record
    }

    return kept
}

async function update(snapshot: AiUsageSnapshot, now: number): Promise<AiUsageSnapshot> {
    const state = await readState()
    const windows = { ...(state.windows ?? {}) }
    const seen = new Set<string>()

    const providers = snapshot.providers.map((provider) => {
        // 取得に失敗した提供元の 0% を「その日は使わなかった」として記録してしまわないようにする
        if (provider.status !== "ok") return provider

        return {
            ...provider,
            windows: provider.windows.map((window) => {
                if (!hasDayMarks(window)) return window

                const key = windowKey(provider.id, window)
                seen.add(key)

                const previous = windows[key]
                const current = isSameWindow(previous, window.resetsAt, window.windowSeconds)
                    ? previous
                    : { resetsAt: window.resetsAt, windowSeconds: window.windowSeconds, marks: [] }

                const next = advance(current, window.usedPercent, now)
                windows[key] = next

                return { ...window, dayMarks: next.marks }
            }),
        }
    })

    await writeState({ windows: prune(windows, seen, now) })
    return { ...snapshot, providers }
}

/**
 * 取得したスナップショットを記録に取り込み、日の区切りを載せたスナップショットを返す。
 * 記録に失敗しても使用状況の表示は続けたいので、そのときは区切り無しのまま返す。
 */
export async function attachDayMarks(
    snapshot: AiUsageSnapshot,
    now: number = Date.now()
): Promise<AiUsageSnapshot> {
    try {
        return await serialize(() => update(snapshot, now))
    } catch (error) {
        console.error("AI usage: 日ごとの区切りを記録できませんでした", error)
        return snapshot
    }
}
