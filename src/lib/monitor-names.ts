import { promises as fs } from "node:fs"
import path from "node:path"
import { MAX_DISPLAY_NAME_LENGTH, monitorNameKey, type MonitorSource } from "@/lib/monitor-source"

/**
 * 監視モニターの表示名の上書き（#479）。
 *
 * Uptime Kuma・UptimeRobot 側のモニター名は変えず、このダッシュボードで出す名前だけを
 * `.data/monitor-display-names.json` に持つ。UptimeRobot は読み取り専用キーで書けず、Kuma の改名も
 * socket 経路（uptime-kuma-admin.ts）頼みで壊れやすいため、取得結果へ上書きする形にしている。
 */

type Overrides = Record<string, string>

function getStatePath(): string {
    return process.env.MONITOR_NAMES_PATH || path.join(process.cwd(), ".data", "monitor-display-names.json")
}

async function readOverrides(): Promise<Overrides> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(), "utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""
            )
        )
    } catch {
        return {}
    }
}

async function writeOverrides(overrides: Overrides): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(overrides, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/** read-modify-write の直列化。PM2 は fork モード1プロセスのため、プロセス内で足りる */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/**
 * 表示名を設定する。前後の空白を除いた結果が空なら、上書きを消して元の名前に戻す。
 * 長すぎる名前は `null`（呼び出し側が400で返す）。
 */
export function setMonitorDisplayName(
    source: MonitorSource,
    id: number,
    name: string
): Promise<"set" | "cleared" | null> {
    const trimmed = name.trim()
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return Promise.resolve(null)

    return serialize(async () => {
        const overrides = await readOverrides()
        const key = monitorNameKey(source, id)

        if (trimmed === "") {
            delete overrides[key]
            await writeOverrides(overrides)
            return "cleared"
        }

        overrides[key] = trimmed
        await writeOverrides(overrides)
        return "set"
    })
}

export function clearMonitorDisplayName(source: MonitorSource, id: number): Promise<void> {
    return setMonitorDisplayName(source, id, "").then(() => undefined)
}

/**
 * 取得したモニターへ表示名を適用する。`name` は変更後の名前、`originalName` は提供元の名前で、
 * 上書きが無ければ `originalName` は付けない。
 */
export async function applyMonitorDisplayNames<T extends { id: number }>(
    source: MonitorSource,
    monitors: T[],
    getName: (monitor: T) => string,
    setName: (monitor: T, name: string, originalName?: string) => T
): Promise<T[]> {
    if (monitors.length === 0) return monitors

    const overrides = await readOverrides()
    return monitors.map((monitor) => {
        const override = overrides[monitorNameKey(source, monitor.id)]
        return override && override !== getName(monitor)
            ? setName(monitor, override, getName(monitor))
            : monitor
    })
}
