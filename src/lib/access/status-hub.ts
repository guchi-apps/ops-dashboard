import { ADMIN_PERMISSION, getAccessDb, STATUS_HUB_APP_ID } from "@/lib/access/db"
import { DECISION_TTL_SECONDS, decideAccess, MAX_STALE_SECONDS } from "@/lib/access/policy"

/**
 * StatusHub自身のログイン判定（#489）。`ALLOWED_EMAILS` の代わりに共通アクセス設定のDBを読む。
 *
 * - 判定は `DECISION_TTL_SECONDS` だけプロセス内にキャッシュする。管理画面からの更新は
 *   同じプロセスのキャッシュを即座に捨てるので、取り消しはログイン済みの利用者にも
 *   次のリクエストから効く。別経路（復旧CLI）での更新は最大でこのTTLの後に効く
 * - DBが読めないときは、直前に読めた判定を `MAX_STALE_SECONDS` まで使い、それを過ぎたら拒否する。
 *   **読めないことを理由に許可を広げない。** 一度も読めていないメールは拒否
 */

export type StatusHubAccess = {
    allowed: boolean
    isAdmin: boolean
    permissions: string[]
}

const DENIED: StatusHubAccess = { allowed: false, isAdmin: false, permissions: [] }

type Entry = { at: number; access: StatusHubAccess }

export function createAccessResolver(options: {
    load: (email: string) => StatusHubAccess
    now?: () => number
    ttlMs?: number
    maxStaleMs?: number
    onError?: (error: unknown) => void
}) {
    const now = options.now ?? Date.now
    const ttlMs = options.ttlMs ?? DECISION_TTL_SECONDS * 1000
    const maxStaleMs = options.maxStaleMs ?? MAX_STALE_SECONDS * 1000
    const cache = new Map<string, Entry>()

    return {
        resolve(rawEmail: string): StatusHubAccess {
            const email = rawEmail.trim().toLowerCase()
            const current = now()
            const entry = cache.get(email)
            if (entry && current - entry.at < ttlMs) return entry.access

            try {
                const access = options.load(email)
                cache.set(email, { at: current, access })
                return access
            } catch (error) {
                options.onError?.(error)
                if (entry && current - entry.at < maxStaleMs) return entry.access
                cache.delete(email)
                return DENIED
            }
        },
        /** 更新した直後に呼び、次の判定でDBを読み直させる */
        invalidate() {
            cache.clear()
        },
    }
}

function loadFromDb(email: string): StatusHubAccess {
    const decision = decideAccess(getAccessDb(), STATUS_HUB_APP_ID, email)
    if (!decision.allowed) return DENIED
    return { allowed: true, isAdmin: decision.permissions.includes(ADMIN_PERMISSION), permissions: decision.permissions }
}

// Next.js はルートごとにモジュールを別々に読み込むことがあるため、globalThis へ1つだけ置く
const globalForAccess = globalThis as unknown as { __statusHubAccess?: ReturnType<typeof createAccessResolver> }

function resolver() {
    globalForAccess.__statusHubAccess ??= createAccessResolver({
        load: loadFromDb,
        onError: (error) =>
            console.error("[access] アクセス設定を読めません（直前の判定を使い、期限後は拒否します）:", error),
    })
    return globalForAccess.__statusHubAccess
}

/** メールがStatusHubを使えるか・管理者か。検証済みのメールだけを渡すこと */
export function getStatusHubAccess(email: string | null | undefined): StatusHubAccess {
    if (!email) return DENIED
    return resolver().resolve(email)
}

/** 更新の直後に呼ぶ。キャッシュを捨てて、取り消しなどを次のリクエストから効かせる */
export function invalidateStatusHubAccess(): void {
    resolver().invalidate()
}
