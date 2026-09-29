import { resolveSharedToken, type SharedTokenCacheEntry } from "@/lib/shared-token"

/**
 * `OPS_API_TOKEN` の取得（#448）。issue-deckの共有トークンAPIを正とし、取得できなければ
 * 環境変数へフォールバックする（`aide-status.ts` の `AIDE_STATUS_TOKEN` と同じ形。#444）。
 *
 * 使う箇所は3つで、キャッシュは共有する（利用元の記録も同じ `ops-dashboard` として付く）。
 * - 受ける側: `session.ts` の `requireSessionOrApiToken()`（`OPS_API_TOKEN`）
 * - 送る側: `ai-app-usage/index.ts`（連携先へのBearer。`OPS_API_TOKEN`）
 * - TypeSafe使用量: `ai-usage/typesafe.ts`（issue-deckが `OPS_API_TOKEN` として検証する値を
 *   別名 `TYPESAFE_USAGE_TOKEN` で持っていた）
 */

const TOKEN_NAME = "OPS_API_TOKEN"
const CONSUMER = "ops-dashboard"

let sharedTokenCache: SharedTokenCacheEntry | null = null

/**
 * 共有トークンを優先し、取得できなければ `fallbackEnvName` の環境変数を返す。
 * 戻り値は認証情報として扱い、ログ・レスポンスへ出さないこと
 */
export async function readOpsApiToken(fallbackEnvName: string = TOKEN_NAME): Promise<string | undefined> {
    const { value, cache } = await resolveSharedToken(TOKEN_NAME, CONSUMER, sharedTokenCache)
    sharedTokenCache = cache

    return value?.trim() || process.env[fallbackEnvName]?.trim() || undefined
}

/** テスト用。プロセス内のキャッシュを空にする */
export function resetOpsApiTokenCache(): void {
    sharedTokenCache = null
}
