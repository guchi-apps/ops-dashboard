import fs from "fs/promises"
import path from "path"

/**
 * リポジトリが「その使用時点で」公開だったか非公開だったかを判定するための記録。
 *
 * Actionsの無料枠を消費するのは非公開リポジトリの分だけだが、課金レポートは公開/非公開を返さない。
 * 現在の公開状態で判定すると、月の途中で公開へ切り替えたリポジトリの「非公開だった期間」の分が
 * まるごと抜け落ち、GitHubの画面より少ない使用量になってしまう（#151）。
 *
 * 無料枠の消費分を直接返すAPIは存在しない（旧 `/orgs/{org}/settings/billing/actions` は410で廃止）
 * ため、取得のたびに公開状態を記録しておき、課金レポートの日付と突き合わせて判定する。
 *
 * **記録できるのは「切り替えた時刻」ではなく「切り替え後に初めて観測した時刻」。**
 * 使用状況の取得はダッシュボードへのリクエスト契機でしか走らず、サーバー側の定期実行は無い。
 * 誰も開かない日が続くと、その期間は切り替え前の状態で判定される（非公開→公開なら多めに出る）。
 * 監査ログで補うこともできない（Team プランでは組織の audit log API が使えない）。
 */

/** ある時刻以降、そのリポジトリがこの公開状態だったことを表す */
interface VisibilityRecord {
    /** この状態を最初に観測した時刻（ISO 8601）。切り替えた時刻そのものではない */
    since: string
    private: boolean
}

interface VisibilityState {
    repositories: Record<string, VisibilityRecord[]>
}

/** 記録が始まる前の期間について、公開状態を判定する手段 */
export interface RepositoryVisibility {
    /** `at` の時点でそのリポジトリが非公開だったか */
    wasPrivateAt(name: string, at: Date): boolean
    /** 現在（最後に観測した時点で）非公開か */
    isPrivateNow(name: string): boolean
}

function getStatePath(): string {
    return (
        process.env.GH_USAGE_VISIBILITY_PATH ||
        path.join(process.cwd(), ".data", "github-repo-visibility.json")
    )
}

/**
 * 記録が始まる前の期間を補正するための設定。
 * `リポジトリ名:日時` をカンマ区切りで並べ、「その日時より前は非公開だった」ことを表す。
 * 例: `GH_USAGE_PRIVATE_UNTIL="db-console:2026-08-19,ops-dashboard:2026-08-18"`
 *
 * 日時は省略形（`YYYY-MM-DD`）ならUTCの0時として扱う。記録が貯まれば不要になるため、
 * 対象の月が過ぎたら削除してよい。
 */
function parsePrivateUntil(): Map<string, number> {
    const result = new Map<string, number>()

    for (const entry of (process.env.GH_USAGE_PRIVATE_UNTIL ?? "").split(",")) {
        const trimmed = entry.trim()
        if (!trimmed) continue

        // リポジトリ名に `:` は使えないため、最初の `:` で区切れば日時側のコロンと衝突しない
        const separator = trimmed.indexOf(":")
        if (separator <= 0) continue

        const name = trimmed.slice(0, separator).trim()
        const until = Date.parse(trimmed.slice(separator + 1).trim())
        if (!name || Number.isNaN(until)) continue

        result.set(name, until)
    }

    return result
}

async function readState(): Promise<VisibilityState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(), "utf8"))
        if (!parsed || typeof parsed !== "object") return { repositories: {} }

        const repositories = (parsed as VisibilityState).repositories
        return { repositories: repositories && typeof repositories === "object" ? repositories : {} }
    } catch {
        return { repositories: {} }
    }
}

async function writeState(state: VisibilityState): Promise<void> {
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

function sortRecords(records: VisibilityRecord[]): VisibilityRecord[] {
    return [...records].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}

/**
 * 今回観測した公開状態を記録へ反映し、判定用のオブジェクトを返す。
 *
 * 記録の書き込みに失敗しても使用状況の表示は続けたいため、例外にはせず警告だけ出す
 * （その場合は現在の公開状態と {@link parsePrivateUntil} の設定だけで判定する）。
 */
export async function trackRepositoryVisibility(
    current: Map<string, boolean>,
    observedAt: Date
): Promise<RepositoryVisibility> {
    const state = await serialize(async () => {
        const loaded = await readState()
        let changed = false

        for (const [name, isPrivate] of current) {
            const records = sortRecords(loaded.repositories[name] ?? [])
            const latest = records.at(-1)
            if (latest && latest.private === isPrivate) continue

            records.push({ since: observedAt.toISOString(), private: isPrivate })
            loaded.repositories[name] = records
            changed = true
        }

        if (changed) {
            try {
                await writeState(loaded)
            } catch (error) {
                console.warn("GitHub usage: 公開状態の記録に失敗", error)
            }
        }

        return loaded
    })

    const privateUntil = parsePrivateUntil()

    return {
        wasPrivateAt(name, at) {
            const records = sortRecords(state.repositories[name] ?? [])
            const atMs = at.getTime()

            // 記録がある期間はそれが正。観測時刻が使用日以前の記録のうち、最も新しいものを使う
            const applicable = records.filter((record) => Date.parse(record.since) <= atMs).at(-1)
            if (applicable) return applicable.private

            // 記録が始まる前は設定で補い、それも無ければ最初に観測した状態で代用する
            const until = privateUntil.get(name)
            if (until !== undefined) return atMs < until

            return records[0]?.private ?? current.get(name) ?? false
        },
        isPrivateNow(name) {
            return current.get(name) ?? false
        },
    }
}
