import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import type { AiProviderId, AiProviderUsage, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/** テストが使う作り物の値と一時ファイル。本番のコードからは参照しない */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const FIVE_HOUR_SECONDS = 5 * 60 * 60
export const WEEK_SECONDS = 7 * 24 * 60 * 60

export function makeWindow(overrides: Partial<AiUsageWindow> = {}): AiUsageWindow {
    return {
        label: "週間",
        usedPercent: 0,
        resetsAt: new Date(Date.UTC(2026, 8, 20)).toISOString(),
        windowSeconds: WEEK_SECONDS,
        ...overrides,
    }
}

export function makeProvider(
    id: AiProviderId,
    windows: AiUsageWindow[],
    overrides: Partial<AiProviderUsage> = {}
): AiProviderUsage {
    return {
        id,
        name: id === "claude" ? "Claude" : "ChatGPT",
        plan: null,
        status: "ok",
        windows,
        ...overrides,
    }
}

export function makeSnapshot(
    providers: AiProviderUsage[],
    fetchedAt: string | number = Date.UTC(2026, 8, 18)
): AiUsageSnapshot {
    return { providers, fetchedAt: new Date(fetchedAt).toISOString() }
}

/**
 * 記録ファイルの保存先を、テストごとの一時ディレクトリへ向ける。
 * 本番の `.data/` を汚さないためで、終わったら環境変数を戻して一時ディレクトリを消す。
 */
export function redirectStateFile(t: TestContext, envName: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ops-dashboard-test-"))
    const file = path.join(dir, "state.json")
    const previous = process.env[envName]

    process.env[envName] = file
    t.after(() => {
        if (previous === undefined) delete process.env[envName]
        else process.env[envName] = previous
        rmSync(dir, { recursive: true, force: true })
    })

    return file
}
