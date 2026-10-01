import { createHash, randomBytes } from "node:crypto"

import {
    ADMIN_PERMISSION,
    STATUS_HUB_APP_ID,
    STATUS_HUB_PERMISSIONS,
    type AccessEnvironment,
    type Db,
} from "@/lib/access/db"

/**
 * 共通アクセス設定の判定と更新（#489）。DBのハンドルを引数で受けるので、テストは
 * `:memory:` のDBへ作り物の値を流せる。時刻も引数（`now`）で渡す。
 *
 * 更新はすべて1つのトランザクションの中で「変更 → 監査履歴 → 影響したアプリの版を進める」を行う。
 * アプリ別の版（`apps.version`）は、そのアプリの判定結果に影響する変更があったときだけ進むので、
 * 無関係な変更でほかのアプリが「反映待ち」に見えることはない。
 */

/** アプリが判定結果を使い回してよい秒数。取り消しはこの時間以内に（DBが読める限り）効く */
export const DECISION_TTL_SECONDS = 30
/** StatusHubに確認できないとき、アプリが直前の判定を使い続けてよい上限。超えたら拒否へ倒す */
export const MAX_STALE_SECONDS = 300
/** 最終確認からこの秒数を過ぎたら「取得失敗（応答なし）」とみなす（確認周期の2倍） */
export const CHECKIN_STALE_SECONDS = MAX_STALE_SECONDS * 2

export type Grants = Record<string, string[]>
export type UserStatus = "active" | "revoked"

export type UserRecord = {
    email: string
    status: UserStatus
    grants: Grants
    createdAt: string
    updatedAt: string
}

export type AppRecord = {
    id: string
    name: string
    permissions: string[]
    version: number
    hasToken: boolean
    tokenIssuedAt: string | null
}

export type AuditRecord = {
    id: number
    at: string
    actor: string
    action: string
    target: string
    before: unknown
    after: unknown
}

export type AccessErrorCode = "invalid" | "not_found" | "last_admin"

export class AccessError extends Error {
    readonly code: AccessErrorCode

    constructor(code: AccessErrorCode, message: string) {
        super(message)
        this.code = code
    }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,29}$/

export function normalizeEmail(value: unknown): string | null {
    if (typeof value !== "string") return null
    const email = value.trim().toLowerCase()
    return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

function tx<T>(db: Db, task: () => T): T {
    db.exec("BEGIN IMMEDIATE")
    try {
        const result = task()
        db.exec("COMMIT")
        return result
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
}

function parseList(value: unknown): string[] {
    try {
        const parsed: unknown = JSON.parse(String(value))
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
        return []
    }
}

function parseJson(value: unknown): unknown {
    if (value === null || value === undefined) return null
    try {
        return JSON.parse(String(value))
    } catch {
        return null
    }
}

function writeAudit(db: Db, now: Date, actor: string, action: string, target: string, before: unknown, after: unknown) {
    db.prepare("INSERT INTO audit (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)").run(
        now.toISOString(),
        actor,
        action,
        target,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after)
    )
}

function bumpApps(db: Db, appIds: Iterable<string>) {
    for (const id of new Set(appIds)) {
        db.prepare("UPDATE apps SET version = version + 1 WHERE id = ?").run(id)
    }
}

// ---- 参照 ----

export function getApp(db: Db, id: string): AppRecord | null {
    const row = db.prepare("SELECT * FROM apps WHERE id = ?").get(id)
    return row ? toApp(row) : null
}

function toApp(row: Record<string, unknown>): AppRecord {
    return {
        id: String(row.id),
        name: String(row.name),
        permissions: parseList(row.permissions),
        version: Number(row.version),
        hasToken: typeof row.token_hash === "string" && row.token_hash !== "",
        tokenIssuedAt: typeof row.token_issued_at === "string" ? row.token_issued_at : null,
    }
}

export function listApps(db: Db): AppRecord[] {
    return db
        .prepare("SELECT * FROM apps ORDER BY (id = ?) DESC, id")
        .all(STATUS_HUB_APP_ID)
        .map(toApp)
}

function readGrants(db: Db, email: string): Grants {
    const grants: Grants = {}
    for (const row of db.prepare("SELECT app_id, permissions FROM grants WHERE email = ? ORDER BY app_id").all(email)) {
        const permissions = parseList(row.permissions)
        if (permissions.length > 0) grants[String(row.app_id)] = permissions
    }
    return grants
}

export function getUser(db: Db, email: string): UserRecord | null {
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email)
    if (!row) return null
    return {
        email: String(row.email),
        status: row.status === "revoked" ? "revoked" : "active",
        grants: readGrants(db, String(row.email)),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    }
}

export function listUsers(db: Db): UserRecord[] {
    return db
        .prepare("SELECT email FROM users ORDER BY (status = 'active') DESC, email")
        .all()
        .map((row) => getUser(db, String(row.email)))
        .filter((user): user is UserRecord => user !== null)
}

export function listAudit(db: Db, limit = 100): AuditRecord[] {
    return db
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
        .all(limit)
        .map((row) => ({
            id: Number(row.id),
            at: String(row.at),
            actor: String(row.actor),
            action: String(row.action),
            target: String(row.target),
            before: parseJson(row.before),
            after: parseJson(row.after),
        }))
}

export function getEnvironment(db: Db): AccessEnvironment {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get()
    return row?.value === "production" ? "production" : "development"
}

// ---- 判定 ----

export type Decision =
    | { allowed: true; permissions: string[]; version: number }
    | { allowed: false; reason: "unknown_app" | "unknown_user" | "revoked" | "no_grant"; version: number | null }

/**
 * メールアドレスがそのアプリを使えるかを返す。未登録・取り消し済み・そのアプリへの付与が無い
 * ときはすべて拒否。呼び出し側は、メールが検証済みのものであることを先に確かめておくこと。
 */
export function decideAccess(db: Db, appId: string, rawEmail: string): Decision {
    const app = getApp(db, appId)
    if (!app) return { allowed: false, reason: "unknown_app", version: null }

    const email = normalizeEmail(rawEmail)
    const user = email ? getUser(db, email) : null
    if (!user) return { allowed: false, reason: "unknown_user", version: app.version }
    if (user.status !== "active") return { allowed: false, reason: "revoked", version: app.version }

    const permissions = user.grants[appId] ?? []
    if (permissions.length === 0) return { allowed: false, reason: "no_grant", version: app.version }
    return { allowed: true, permissions, version: app.version }
}

// ---- 更新 ----

function activeAdminCount(db: Db): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS n FROM users u JOIN grants g ON g.email = u.email
             WHERE u.status = 'active' AND g.app_id = ? AND g.permissions LIKE ?`
        )
        .get(STATUS_HUB_APP_ID, `%"${ADMIN_PERMISSION}"%`)
    return Number(row?.n ?? 0)
}

function assertAdminRemains(db: Db) {
    if (activeAdminCount(db) < 1) {
        throw new AccessError("last_admin", "最後の管理者は取り消せません。先に別の管理者を追加してください")
    }
}

export type UserInput = {
    email: string
    /** 省略すると、新規は `active`、既存は変更しない */
    status?: UserStatus
    /** 省略すると付与は変更しない。渡すと、そのアプリ別の権限へ丸ごと置き換える */
    grants?: Grants
}

/** ユーザーを追加・変更・取り消しする。変化が無ければ何も書かない（`changed: false`） */
export function upsertUser(db: Db, actor: string, input: UserInput, now: Date): { user: UserRecord; changed: boolean } {
    const email = normalizeEmail(input.email)
    if (!email) throw new AccessError("invalid", "メールアドレスの形式が正しくありません")
    if (input.status !== undefined && input.status !== "active" && input.status !== "revoked") {
        throw new AccessError("invalid", "状態は active か revoked を指定してください")
    }

    return tx(db, () => {
        const before = getUser(db, email)
        const nextStatus: UserStatus = input.status ?? before?.status ?? "active"

        let nextGrants = before?.grants ?? {}
        if (input.grants !== undefined) {
            nextGrants = {}
            for (const [appId, permissions] of Object.entries(input.grants)) {
                const app = getApp(db, appId)
                if (!app) throw new AccessError("invalid", `未登録のアプリです: ${appId}`)
                const list = [...new Set(permissions)]
                const unknown = list.filter((permission) => !app.permissions.includes(permission))
                if (unknown.length > 0) {
                    throw new AccessError("invalid", `${app.name}が対応していない権限です: ${unknown.join(", ")}`)
                }
                if (list.length > 0) nextGrants[appId] = list.sort()
            }
        }

        const beforeState = before ? { status: before.status, grants: before.grants } : null
        const afterState = { status: nextStatus, grants: nextGrants }
        if (before && JSON.stringify(beforeState) === JSON.stringify(afterState)) {
            return { user: before, changed: false }
        }

        const at = now.toISOString()
        if (!before) {
            db.prepare("INSERT INTO users (email, status, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
                email,
                nextStatus,
                at,
                at
            )
        } else {
            db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE email = ?").run(nextStatus, at, email)
        }

        if (input.grants !== undefined) {
            db.prepare("DELETE FROM grants WHERE email = ?").run(email)
            for (const [appId, permissions] of Object.entries(nextGrants)) {
                db.prepare("INSERT INTO grants (email, app_id, permissions) VALUES (?, ?, ?)").run(
                    email,
                    appId,
                    JSON.stringify(permissions)
                )
            }
        }

        assertAdminRemains(db)

        const action = !before
            ? "user.create"
            : before.status !== nextStatus
              ? nextStatus === "revoked"
                  ? "user.revoke"
                  : "user.restore"
              : "user.update"
        writeAudit(db, now, actor, action, email, beforeState, afterState)

        // 状態の変更はすべてのアプリへ、権限の変更は前後どちらかで付与があったアプリへ影響する
        bumpApps(db, [...Object.keys(before?.grants ?? {}), ...Object.keys(nextGrants)])

        return { user: getUser(db, email)!, changed: true }
    })
}

export type AppInput = { id: string; name: string; permissions: string[] }

/** 連携するアプリを登録・変更する。StatusHub自身は定義を変えられない */
export function upsertApp(db: Db, actor: string, input: AppInput, now: Date): AppRecord {
    if (input.id === STATUS_HUB_APP_ID) {
        throw new AccessError("invalid", "StatusHub自身の定義は変更できません")
    }
    if (!APP_ID_PATTERN.test(input.id)) {
        throw new AccessError("invalid", "アプリIDは英小文字・数字・ハイフンの2〜40文字で指定してください")
    }
    const name = input.name.trim()
    if (name === "" || name.length > 60) throw new AccessError("invalid", "アプリ名は1〜60文字で入力してください")
    const permissions = [...new Set(input.permissions.map((permission) => permission.trim()))].filter(Boolean)
    if (permissions.length === 0 || permissions.length > 12 || !permissions.every((p) => PERMISSION_PATTERN.test(p))) {
        throw new AccessError("invalid", "権限は英小文字・数字・_-の1〜30文字で、1〜12個指定してください")
    }

    return tx(db, () => {
        const before = getApp(db, input.id)
        const beforeState = before ? { name: before.name, permissions: before.permissions } : null
        const afterState = { name, permissions }
        if (before && JSON.stringify(beforeState) === JSON.stringify(afterState)) return before

        if (!before) {
            db.prepare("INSERT INTO apps (id, name, permissions, version, created_at) VALUES (?, ?, ?, 1, ?)").run(
                input.id,
                name,
                JSON.stringify(permissions),
                now.toISOString()
            )
        } else {
            db.prepare("UPDATE apps SET name = ?, permissions = ? WHERE id = ?").run(
                name,
                JSON.stringify(permissions),
                input.id
            )
            // 対応しなくなった権限は付与からも外す
            for (const row of db.prepare("SELECT email, permissions FROM grants WHERE app_id = ?").all(input.id)) {
                const kept = parseList(row.permissions).filter((permission) => permissions.includes(permission))
                if (kept.length === 0) {
                    db.prepare("DELETE FROM grants WHERE email = ? AND app_id = ?").run(String(row.email), input.id)
                } else {
                    db.prepare("UPDATE grants SET permissions = ? WHERE email = ? AND app_id = ?").run(
                        JSON.stringify(kept),
                        String(row.email),
                        input.id
                    )
                }
            }
            bumpApps(db, [input.id])
        }
        writeAudit(db, now, actor, before ? "app.update" : "app.create", input.id, beforeState, afterState)
        return getApp(db, input.id)!
    })
}

// ---- アプリ別トークン ----

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
}

/**
 * アプリ別の読み取りトークンを発行（再発行）する。平文はこの戻り値でしか得られず、DBには
 * ハッシュだけを残す。再発行すると古いトークンは即座に使えなくなる。
 */
export function issueAppToken(db: Db, actor: string, appId: string, now: Date): string {
    if (appId === STATUS_HUB_APP_ID) throw new AccessError("invalid", "StatusHub自身にトークンは要りません")
    return tx(db, () => {
        const app = getApp(db, appId)
        if (!app) throw new AccessError("not_found", "アプリが見つかりません")

        const token = `sha_${randomBytes(32).toString("base64url")}`
        db.prepare("UPDATE apps SET token_hash = ?, token_issued_at = ? WHERE id = ?").run(
            hashToken(token),
            now.toISOString(),
            appId
        )
        writeAudit(db, now, actor, app.hasToken ? "token.reissue" : "token.issue", appId, null, null)
        return token
    })
}

export function revokeAppToken(db: Db, actor: string, appId: string, now: Date): void {
    tx(db, () => {
        const app = getApp(db, appId)
        if (!app) throw new AccessError("not_found", "アプリが見つかりません")
        if (!app.hasToken) return
        db.prepare("UPDATE apps SET token_hash = NULL, token_issued_at = NULL WHERE id = ?").run(appId)
        writeAudit(db, now, actor, "token.revoke", appId, null, null)
    })
}

/** 提示されたトークンから、そのトークンを発行したアプリを引く。見つからなければ null */
export function findAppByToken(db: Db, token: string): AppRecord | null {
    if (!token) return null
    const row = db.prepare("SELECT * FROM apps WHERE token_hash = ?").get(hashToken(token))
    return row ? toApp(row) : null
}

// ---- 反映状況 ----

export type CheckinInput = {
    /** アプリが適用中と申告した版。判定APIの呼び出しに付いてくる */
    appliedVersion: number | null
    ok: boolean
    error?: string
}

export function recordCheckin(db: Db, appId: string, input: CheckinInput, now: Date): void {
    const at = now.toISOString()
    db.prepare(
        `INSERT INTO checkins (app_id, applied_version, last_seen_at, last_ok_at, last_error, last_error_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
             applied_version = CASE WHEN excluded.applied_version IS NULL THEN applied_version ELSE excluded.applied_version END,
             last_seen_at = excluded.last_seen_at,
             last_ok_at = CASE WHEN ? = 1 THEN excluded.last_ok_at ELSE last_ok_at END,
             last_error = CASE WHEN ? = 1 THEN NULL ELSE excluded.last_error END,
             last_error_at = CASE WHEN ? = 1 THEN last_error_at ELSE excluded.last_error_at END`
    ).run(
        appId,
        input.appliedVersion,
        at,
        input.ok ? at : null,
        input.ok ? null : (input.error ?? "error"),
        input.ok ? null : at,
        input.ok ? 1 : 0,
        input.ok ? 1 : 0,
        input.ok ? 1 : 0
    )
}

export type SyncStatus = "unlinked" | "pending" | "synced" | "failed"

export type SyncState = {
    status: SyncStatus
    /** アプリが申告した適用中の版 */
    appliedVersion: number | null
    /** 保存済みの最新の版 */
    savedVersion: number
    lastSeenAt: string | null
    lastOkAt: string | null
    /** 失敗の理由（画面に出す短い文言。秘匿値は含まない） */
    detail: string | null
}

type CheckinRow = {
    applied_version: number | null
    last_seen_at: string
    last_ok_at: string | null
    last_error: string | null
    last_error_at: string | null
}

export function readCheckin(db: Db, appId: string): CheckinRow | null {
    const row = db.prepare("SELECT * FROM checkins WHERE app_id = ?").get(appId)
    if (!row) return null
    return {
        applied_version: row.applied_version === null ? null : Number(row.applied_version),
        last_seen_at: String(row.last_seen_at),
        last_ok_at: typeof row.last_ok_at === "string" ? row.last_ok_at : null,
        last_error: typeof row.last_error === "string" ? row.last_error : null,
        last_error_at: typeof row.last_error_at === "string" ? row.last_error_at : null,
    }
}

/**
 * 保存した版とアプリの確認状況から、反映状況を決める。**StatusHub側だけで推定する**ため、
 * アプリが申告した版が実際に効いているかまでは保証しない。保存に成功しただけでは `synced` にならず、
 * 取得に失敗した・確認が途絶えたアプリは `synced` のままにしない。
 */
export function computeSyncState(savedVersion: number, checkin: CheckinRow | null, now: Date): SyncState {
    if (!checkin) {
        return { status: "unlinked", appliedVersion: null, savedVersion, lastSeenAt: null, lastOkAt: null, detail: null }
    }

    const base = {
        appliedVersion: checkin.applied_version,
        savedVersion,
        lastSeenAt: checkin.last_seen_at,
        lastOkAt: checkin.last_ok_at,
    }
    const failedLast =
        checkin.last_error_at !== null && (checkin.last_ok_at === null || checkin.last_error_at >= checkin.last_ok_at)
    if (failedLast) return { ...base, status: "failed", detail: checkin.last_error ?? "取得に失敗しました" }

    const silentSeconds = (now.getTime() - new Date(checkin.last_seen_at).getTime()) / 1000
    if (silentSeconds > CHECKIN_STALE_SECONDS) return { ...base, status: "failed", detail: "応答がありません" }

    if (checkin.applied_version === null || checkin.applied_version < savedVersion) {
        return { ...base, status: "pending", detail: null }
    }
    return { ...base, status: "synced", detail: null }
}

export { STATUS_HUB_PERMISSIONS }
