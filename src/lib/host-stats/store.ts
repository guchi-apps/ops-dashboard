import fs from "fs/promises"
import path from "path"
import type {
    HostStatsHistoryPoint,
    HostStatsReport,
    HostStatsSnapshot,
    HostStatsView,
} from "@/types/host-stats"

/**
 * サブPCから受け取ったメトリクスの保管。
 *
 * 保存先は deploy.yml の削除対象に含まれない `.data/` を既定とし、デプロイをまたいで
 * 履歴が消えないようにする（AI使用状況のトークン保管と同じ考え方）。
 */

const DEFAULT_OFFLINE_AFTER_SECONDS = 300
const DEFAULT_HISTORY_HOURS = 24
const DEFAULT_LABEL = "サブPC"

/** グラフに載せる点の上限。1分間隔・24時間の1440点をそのまま返すとレスポンスが太るため間引く */
const MAX_VIEW_POINTS = 180

/** 履歴ファイルの1行あたりの見積もり。これを超えて膨らんだら期限切れの行を掃除する */
const HISTORY_LINE_BYTES = 120

function getSnapshotPath(): string {
    return process.env.HOST_STATS_STATE_PATH || path.join(process.cwd(), ".data", "host-stats-latest.json")
}

function getHistoryPath(): string {
    return process.env.HOST_STATS_HISTORY_PATH || path.join(process.cwd(), ".data", "host-stats-history.jsonl")
}

function readPositiveInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getOfflineAfterSeconds(): number {
    return readPositiveInt("HOST_STATS_OFFLINE_AFTER_SECONDS", DEFAULT_OFFLINE_AFTER_SECONDS)
}

export function getHistoryHours(): number {
    return readPositiveInt("HOST_STATS_HISTORY_HOURS", DEFAULT_HISTORY_HOURS)
}

function getLabel(): string {
    return process.env.HOST_STATS_LABEL || DEFAULT_LABEL
}

/**
 * ファイルへの読み書きを直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

async function writeFileAtomic(file: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, contents)
    await fs.rename(tempFile, file)
}

function toHistoryPoint(snapshot: HostStatsSnapshot): HostStatsHistoryPoint {
    // ディスクは複数を受け取れるが、履歴には最も使用率が高いものだけを残す
    const disk = snapshot.disks.reduce((worst, entry) =>
        entry.usedPercent > worst.usedPercent ? entry : worst
    )

    return {
        t: Math.floor(new Date(snapshot.receivedAt).getTime() / 1000),
        cpu: snapshot.cpuPercent,
        mem: snapshot.memory.usedPercent,
        disk: disk.usedPercent,
        load: snapshot.loadAverage[0],
        swap: snapshot.swap?.usedPercent,
        temp: snapshot.temperatureCelsius,
    }
}

function parseHistoryLines(raw: string, cutoffSeconds: number): HostStatsHistoryPoint[] {
    const points: HostStatsHistoryPoint[] = []

    for (const line of raw.split("\n")) {
        if (!line) continue
        try {
            const point = JSON.parse(line) as HostStatsHistoryPoint
            if (typeof point?.t === "number" && point.t >= cutoffSeconds) points.push(point)
        } catch {
            // 書き込み途中で切れた行などは捨てる
        }
    }

    return points
}

async function readHistoryFile(cutoffSeconds: number): Promise<HostStatsHistoryPoint[]> {
    try {
        return parseHistoryLines(await fs.readFile(getHistoryPath(), "utf8"), cutoffSeconds)
    } catch {
        return []
    }
}

async function appendHistory(point: HostStatsHistoryPoint): Promise<void> {
    const file = getHistoryPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `${JSON.stringify(point)}\n`)

    // 毎回全体を書き直すと無駄なため、想定サイズを超えたときだけ期限切れの行を落とす
    const maxBytes = getHistoryHours() * 60 * HISTORY_LINE_BYTES * 2
    const { size } = await fs.stat(file)
    if (size <= maxBytes) return

    const cutoffSeconds = Math.floor(Date.now() / 1000) - getHistoryHours() * 3600
    const kept = await readHistoryFile(cutoffSeconds)
    await writeFileAtomic(file, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
}

/** 受信したレポートを最新スナップショットとして保存し、履歴に1点追加する */
export async function saveHostStatsReport(report: HostStatsReport): Promise<HostStatsSnapshot> {
    const snapshot: HostStatsSnapshot = { ...report, receivedAt: new Date().toISOString() }

    await serialize(async () => {
        await writeFileAtomic(getSnapshotPath(), `${JSON.stringify(snapshot, null, 2)}\n`)
        await appendHistory(toHistoryPoint(snapshot))
    })

    return snapshot
}

async function readSnapshot(): Promise<HostStatsSnapshot | null> {
    try {
        const raw = await fs.readFile(getSnapshotPath(), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return null
        return parsed as HostStatsSnapshot
    } catch {
        return null
    }
}

function average(values: number[]): number {
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

/** 点が多いときは等間隔のバケットに束ねて平均を取る（形が保たれればよいので単純平均でよい） */
function downsample(points: HostStatsHistoryPoint[]): HostStatsHistoryPoint[] {
    if (points.length <= MAX_VIEW_POINTS) return points

    const bucketSize = Math.ceil(points.length / MAX_VIEW_POINTS)
    const result: HostStatsHistoryPoint[] = []

    for (let index = 0; index < points.length; index += bucketSize) {
        const bucket = points.slice(index, index + bucketSize)
        const swap = bucket.map((point) => point.swap).filter((value) => value !== undefined)
        const temp = bucket.map((point) => point.temp).filter((value) => value !== undefined)

        result.push({
            t: bucket[bucket.length - 1].t,
            cpu: average(bucket.map((point) => point.cpu)),
            mem: average(bucket.map((point) => point.mem)),
            disk: average(bucket.map((point) => point.disk)),
            load: average(bucket.map((point) => point.load)),
            swap: swap.length > 0 ? average(swap) : undefined,
            temp: temp.length > 0 ? average(temp) : undefined,
        })
    }

    return result
}

/** ダッシュボード表示用に、最新スナップショットと間引いた履歴をまとめて返す */
export async function getHostStatsView(): Promise<HostStatsView> {
    const historyHours = getHistoryHours()
    const offlineAfterSeconds = getOfflineAfterSeconds()
    const cutoffSeconds = Math.floor(Date.now() / 1000) - historyHours * 3600

    const [latest, history] = await Promise.all([readSnapshot(), readHistoryFile(cutoffSeconds)])

    const ageSeconds = latest
        ? Math.max(0, Math.round((Date.now() - new Date(latest.receivedAt).getTime()) / 1000))
        : null

    return {
        latest,
        label: getLabel(),
        ageSeconds,
        online: ageSeconds !== null && ageSeconds <= offlineAfterSeconds,
        offlineAfterSeconds,
        historyHours,
        history: downsample(history),
    }
}
