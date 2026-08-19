/**
 * AI・GitHub・1Password の使用状況をプロセス内にキャッシュするための共通部品。
 *
 * いずれも提供元のレート制限が厳しく、画面を開くたびに叩けない。通常は各モジュールが決めた
 * TTL のあいだキャッシュを返し、ヘッダーの更新ボタンから来た取得（`force`）だけ TTL を無視して
 * 取り直す。ただし連打で提供元を叩き続けないよう、`force` でも直前の取得から
 * {@link MIN_FORCE_REFRESH_MS} のあいだはキャッシュを返す。
 */

/** 手動更新でも提供元へ取りにいかない最短間隔 */
export const MIN_FORCE_REFRESH_MS = 30_000

export interface UsageCacheEntry<T> {
    snapshot: T
    /** このスナップショットを取得した時刻（epoch ミリ秒） */
    fetchedAtMs: number
    /** 通常の取得でキャッシュを使ってよい期限（epoch ミリ秒） */
    expiresAt: number
}

/** キャッシュをそのまま返してよいか */
export function isUsageCacheFresh<T>(
    entry: UsageCacheEntry<T> | null,
    force: boolean,
    now: number = Date.now()
): boolean {
    if (!entry) return false
    return force ? now - entry.fetchedAtMs < MIN_FORCE_REFRESH_MS : entry.expiresAt > now
}

/** 取得したスナップショットをキャッシュに載せる形へ整える */
export function newUsageCacheEntry<T>(
    snapshot: T,
    ttlMs: number,
    now: number = Date.now()
): UsageCacheEntry<T> {
    return { snapshot, fetchedAtMs: now, expiresAt: now + ttlMs }
}

/** 使用状況を取得する関数が受け取るオプション */
export interface UsageFetchOptions {
    /** true なら TTL を無視して提供元へ取り直す（最短間隔のガードは効く） */
    force?: boolean
}
