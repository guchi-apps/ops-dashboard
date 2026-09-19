import { getClaudeUsageEntry } from "@/lib/ai-usage/claude"
import { describeError } from "@/lib/upstream"
import type { ClaudeUsageWidgetResponse } from "@/types/claude-usage"

/**
 * ウィジェット（Scriptable）向けに、Claude の利用枠を上流のJSONのまま中継する。
 *
 * 取得はダッシュボード表示用の `getAiUsageSnapshot()` と同じキャッシュ（`getClaudeUsageEntry`）を通す。
 * 別々にキャッシュを持つと両方の取得が重なったときに同じエンドポイントへの間隔が180秒を割り、
 * 429でどちらも取れなくなるため（#273）。ウィジェットは決まったキーだけを読む・失敗しても空に
 * したくない、という要件が異なるため、レスポンス形と「最後に取れた値」だけをここで持つ。
 */

/**
 * ウィジェット側のタイムアウトが8秒のため、それより先に打ち切って古い値を返す。
 * 取得そのものは打ち切らないので、終われば次の要求からキャッシュが使われる
 */
const TIMEOUT_MS = 7_000

let lastOk: { data: Record<string, unknown>; fetchedAt: number } | null = null

function shape(entry: NonNullable<typeof lastOk>, stale: boolean): ClaudeUsageWidgetResponse {
    return {
        ...entry.data,
        collected_at: new Date(entry.fetchedAt).toISOString(),
        stale,
    }
}

async function fetchUsage(): Promise<NonNullable<typeof lastOk>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("使用状況の取得がタイムアウトしました")), TIMEOUT_MS)
    })

    try {
        const entry = await Promise.race([getClaudeUsageEntry(), timeout])
        const { usage, raw } = entry.snapshot
        if (!raw) {
            throw new Error(usage.message ?? "使用状況を取得できませんでした")
        }
        return { data: raw, fetchedAt: entry.fetchedAtMs }
    } finally {
        clearTimeout(timer)
    }
}

/**
 * 上流に失敗しても、前に取れた値があれば `stale: true` を付けて返し、
 * ウィジェットが空になることを避ける。それも無いときだけ例外を投げる。
 */
export async function getClaudeUsageForWidget(): Promise<ClaudeUsageWidgetResponse> {
    try {
        lastOk = await fetchUsage()
        return shape(lastOk, false)
    } catch (error) {
        // アクセストークンは組み立てたヘッダーにしか載せていないため、ここには出ない
        console.warn("Claude usage (widget): 取得に失敗", describeError(error))

        if (lastOk) {
            return { ...shape(lastOk, true), error: describeError(error) }
        }
        throw error
    }
}
