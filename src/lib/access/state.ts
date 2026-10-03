import { getAccessDb, STATUS_HUB_APP_ID } from "@/lib/access/db"
import { computeSyncState, getEnvironment, listApps, listAudit, listLoginEvents, listUsers, readCheckin } from "@/lib/access/policy"

/** 管理画面が読む全体の状態（#489）。管理者の確認を済ませた呼び出し元だけが使うこと */
export function buildAccessState(now: Date = new Date()) {
    const db = getAccessDb()
    const apps = listApps(db).map((app) => ({
        ...app,
        // StatusHub自身は同じDBを直接読むため、常に最新を反映している
        sync:
            app.id === STATUS_HUB_APP_ID
                ? {
                      status: "synced" as const,
                      appliedVersion: app.version,
                      savedVersion: app.version,
                      lastSeenAt: now.toISOString(),
                      lastOkAt: now.toISOString(),
                      detail: null,
                  }
                : computeSyncState(app.version, readCheckin(db, app.id), now),
    }))
    return { environment: getEnvironment(db), apps, users: listUsers(db), audit: listAudit(db, 100), logins: listLoginEvents(db) }
}

export type AccessState = ReturnType<typeof buildAccessState>
