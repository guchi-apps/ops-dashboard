import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { AccessEnvironmentMismatchError, openAccessDb, type Db } from "@/lib/access/db"
import {
    AccessError,
    CHECKIN_STALE_SECONDS,
    computeSyncState,
    decideAccess,
    findAppByToken,
    getApp,
    issueAppToken,
    listAudit,
    readCheckin,
    recordCheckin,
    revokeAppToken,
    upsertApp,
    upsertUser,
} from "@/lib/access/policy"
import { createAccessResolver } from "@/lib/access/status-hub"

const T0 = new Date("2026-10-01T00:00:00.000Z")
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

function freshDb(seedAdminEmails: string[] = ["owner@example.com"], environment: "production" | "development" = "development"): Db {
    return openAccessDb(":memory:", { environment, seedAdminEmails, now: T0 })
}

function withApp(db: Db) {
    upsertApp(db, "owner@example.com", { id: "issue-deck", name: "issue-deck", permissions: ["viewer", "editor"] }, T0)
}

describe("初期化と移行", () => {
    it("ALLOWED_EMAILS は初回だけ管理者として取り込み、履歴へ残す", () => {
        const db = freshDb(["Owner@Example.com", "owner@example.com"])
        assert.deepEqual(decideAccess(db, "status-hub", "owner@example.com"), {
            allowed: true,
            permissions: ["admin"],
            version: 1,
        })
        const audit = listAudit(db)
        assert.equal(audit.length, 1)
        assert.equal(audit[0].actor, "system:migration")
    })

    it("環境がDBと食い違えば開けず、取り込みもしない", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "access-"))
        try {
            const file = path.join(dir, "access.sqlite")
            openAccessDb(file, { environment: "production", seedAdminEmails: ["a@example.com"], now: T0 }).close()
            assert.throws(
                () => openAccessDb(file, { environment: "development", seedAdminEmails: ["b@example.com"], now: T0 }),
                AccessEnvironmentMismatchError
            )
            const again = openAccessDb(file, { environment: "production", seedAdminEmails: ["b@example.com"], now: T0 })
            // 2回目以降は取り込まない
            assert.equal(decideAccess(again, "status-hub", "b@example.com").allowed, false)
            again.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("判定", () => {
    it("未登録・付与なし・取り消し済みは拒否し、付与があるアプリだけ許可する", () => {
        const db = freshDb()
        withApp(db)
        upsertUser(db, "owner@example.com", { email: "family@example.com", grants: { "issue-deck": ["viewer"] } }, T0)

        assert.equal(decideAccess(db, "issue-deck", "stranger@example.com").allowed, false)
        assert.equal(decideAccess(db, "issue-deck", "family@example.com").allowed, true)
        // 他アプリの権限は持たない（StatusHubへは入れない）
        assert.deepEqual(decideAccess(db, "status-hub", "family@example.com"), {
            allowed: false,
            reason: "no_grant",
            version: 1,
        })
        assert.equal(decideAccess(db, "unknown", "family@example.com").allowed, false)

        upsertUser(db, "owner@example.com", { email: "family@example.com", status: "revoked" }, T0)
        const revoked = decideAccess(db, "issue-deck", "family@example.com")
        assert.equal(revoked.allowed, false)
        assert.equal(revoked.allowed === false && revoked.reason, "revoked")
    })

    it("アプリが対応しない権限・未登録アプリへの付与は拒否する", () => {
        const db = freshDb()
        withApp(db)
        assert.throws(
            () => upsertUser(db, "owner@example.com", { email: "a@example.com", grants: { "issue-deck": ["root"] } }, T0),
            (error) => error instanceof AccessError && error.code === "invalid"
        )
        assert.throws(
            () => upsertUser(db, "owner@example.com", { email: "a@example.com", grants: { nope: ["viewer"] } }, T0),
            (error) => error instanceof AccessError && error.code === "invalid"
        )
        assert.throws(() => upsertUser(db, "owner@example.com", { email: "not-an-email" }, T0), AccessError)
    })
})

describe("最後の管理者の保護", () => {
    it("最後の管理者の取り消し・権限の削除は拒否し、状態を変えない", () => {
        const db = freshDb()
        const lastAdmin = (error: unknown) => error instanceof AccessError && error.code === "last_admin"
        assert.throws(() => upsertUser(db, "owner@example.com", { email: "owner@example.com", status: "revoked" }, T0), lastAdmin)
        assert.throws(() => upsertUser(db, "owner@example.com", { email: "owner@example.com", grants: {} }, T0), lastAdmin)
        assert.throws(
            () => upsertUser(db, "owner@example.com", { email: "owner@example.com", grants: { "status-hub": ["member"] } }, T0),
            lastAdmin
        )
        assert.equal(decideAccess(db, "status-hub", "owner@example.com").allowed, true)
        assert.equal(listAudit(db).length, 1)
    })

    it("別の管理者がいれば取り消せる", () => {
        const db = freshDb()
        upsertUser(db, "owner@example.com", { email: "second@example.com", grants: { "status-hub": ["admin"] } }, T0)
        upsertUser(db, "second@example.com", { email: "owner@example.com", status: "revoked" }, T0)
        assert.equal(decideAccess(db, "status-hub", "owner@example.com").allowed, false)
    })
})

describe("版と監査履歴", () => {
    it("影響したアプリの版だけが進み、変化が無い更新は何も書かない", () => {
        const db = freshDb()
        withApp(db)
        const base = getApp(db, "issue-deck")!.version
        const hub = getApp(db, "status-hub")!.version

        upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["viewer"] } }, T0)
        assert.equal(getApp(db, "issue-deck")!.version, base + 1)
        assert.equal(getApp(db, "status-hub")!.version, hub)

        const count = listAudit(db).length
        const same = upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["viewer"] } }, T0)
        assert.equal(same.changed, false)
        assert.equal(listAudit(db).length, count)
        assert.equal(getApp(db, "issue-deck")!.version, base + 1)
    })

    it("変更者・対象・変更前後を残す", () => {
        const db = freshDb()
        withApp(db)
        upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["viewer"] } }, at(10))
        upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["viewer", "editor"] } }, at(20))
        const [latest] = listAudit(db)
        assert.equal(latest.actor, "owner@example.com")
        assert.equal(latest.action, "user.update")
        assert.equal(latest.target, "f@example.com")
        assert.deepEqual(latest.before, { status: "active", grants: { "issue-deck": ["viewer"] } })
        assert.deepEqual(latest.after, { status: "active", grants: { "issue-deck": ["editor", "viewer"] } })
    })

    it("アプリが対応しなくなった権限は付与から外れる", () => {
        const db = freshDb()
        withApp(db)
        upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["editor"] } }, T0)
        upsertApp(db, "owner@example.com", { id: "issue-deck", name: "issue-deck", permissions: ["viewer"] }, T0)
        assert.equal(decideAccess(db, "issue-deck", "f@example.com").allowed, false)
    })

    it("StatusHub自身の定義は変えられない", () => {
        const db = freshDb()
        assert.throws(() => upsertApp(db, "owner@example.com", { id: "status-hub", name: "x", permissions: ["root"] }, T0), AccessError)
    })
})

describe("アプリ別トークン", () => {
    it("平文はDBに残らず、発行したアプリだけを引ける。再発行・失効で古いものは使えない", () => {
        const db = freshDb()
        withApp(db)
        upsertApp(db, "owner@example.com", { id: "aide", name: "AIDE", permissions: ["viewer"] }, T0)

        const first = issueAppToken(db, "owner@example.com", "issue-deck", T0)
        const other = issueAppToken(db, "owner@example.com", "aide", T0)
        assert.equal(findAppByToken(db, first)?.id, "issue-deck")
        assert.equal(findAppByToken(db, other)?.id, "aide")
        assert.equal(findAppByToken(db, "wrong"), null)
        assert.equal(findAppByToken(db, ""), null)

        const rows = db.prepare("SELECT token_hash FROM apps").all()
        assert.ok(rows.every((row) => row.token_hash === null || !String(row.token_hash).includes(first)))
        assert.ok(listAudit(db).every((entry) => !JSON.stringify(entry).includes(first)))

        const second = issueAppToken(db, "owner@example.com", "issue-deck", T0)
        assert.equal(findAppByToken(db, first), null)
        assert.equal(findAppByToken(db, second)?.id, "issue-deck")

        revokeAppToken(db, "owner@example.com", "issue-deck", T0)
        assert.equal(findAppByToken(db, second), null)
        assert.equal(findAppByToken(db, other)?.id, "aide")
    })
})

describe("反映状況", () => {
    it("未連携 → 反映待ち → 反映済みと進み、保存しただけでは反映済みにならない", () => {
        const db = freshDb()
        withApp(db)
        const version = () => getApp(db, "issue-deck")!.version
        const state = (now: Date) => computeSyncState(version(), readCheckin(db, "issue-deck"), now)

        assert.equal(state(at(0)).status, "unlinked")

        recordCheckin(db, "issue-deck", { appliedVersion: version(), ok: true }, at(1))
        assert.equal(state(at(2)).status, "synced")

        upsertUser(db, "owner@example.com", { email: "f@example.com", grants: { "issue-deck": ["viewer"] } }, at(3))
        assert.equal(state(at(4)).status, "pending")

        recordCheckin(db, "issue-deck", { appliedVersion: version(), ok: true }, at(5))
        const synced = state(at(6))
        assert.equal(synced.status, "synced")
        assert.equal(synced.lastOkAt, at(5).toISOString())
    })

    it("取得失敗と無応答は反映済みにしない。成功すれば戻る", () => {
        const db = freshDb()
        withApp(db)
        const version = getApp(db, "issue-deck")!.version

        recordCheckin(db, "issue-deck", { appliedVersion: version, ok: true }, at(0))
        recordCheckin(db, "issue-deck", { appliedVersion: null, ok: false, error: "リクエストの形式が不正です" }, at(10))
        const failed = computeSyncState(version, readCheckin(db, "issue-deck"), at(11))
        assert.equal(failed.status, "failed")
        assert.equal(failed.detail, "リクエストの形式が不正です")
        // 失敗しても、直前に成功した版と時刻は残る
        assert.equal(failed.appliedVersion, version)
        assert.equal(failed.lastOkAt, at(0).toISOString())

        recordCheckin(db, "issue-deck", { appliedVersion: version, ok: true }, at(20))
        assert.equal(computeSyncState(version, readCheckin(db, "issue-deck"), at(21)).status, "synced")

        const silent = computeSyncState(version, readCheckin(db, "issue-deck"), at(20 + CHECKIN_STALE_SECONDS + 1))
        assert.equal(silent.status, "failed")
        assert.equal(silent.detail, "応答がありません")
    })
})

describe("StatusHub自身の判定のキャッシュ", () => {
    const allow = { allowed: true, isAdmin: false, permissions: ["member"] }

    it("TTLの間は読み直さず、過ぎたら読み直して取り消しが効く", () => {
        let current = 0
        let loaded = allow
        let calls = 0
        const resolver = createAccessResolver({
            load: () => {
                calls++
                return loaded
            },
            now: () => current,
            ttlMs: 30_000,
            maxStaleMs: 300_000,
        })
        assert.equal(resolver.resolve("A@Example.com").allowed, true)
        loaded = { allowed: false, isAdmin: false, permissions: [] }
        current = 29_000
        assert.equal(resolver.resolve("a@example.com").allowed, true)
        assert.equal(calls, 1)
        current = 30_000
        assert.equal(resolver.resolve("a@example.com").allowed, false)
        resolver.invalidate()
    })

    it("読めないときは直前の判定を上限まで使い、過ぎたら拒否する。未確認のメールは拒否", () => {
        let current = 0
        let broken = false
        const resolver = createAccessResolver({
            load: () => {
                if (broken) throw new Error("db down")
                return allow
            },
            now: () => current,
            ttlMs: 30_000,
            maxStaleMs: 300_000,
            onError: () => {},
        })
        assert.equal(resolver.resolve("a@example.com").allowed, true)
        broken = true
        current = 100_000
        assert.equal(resolver.resolve("a@example.com").allowed, true)
        assert.equal(resolver.resolve("never-seen@example.com").allowed, false)
        current = 300_000
        assert.equal(resolver.resolve("a@example.com").allowed, false)
    })
})

describe("復旧CLI", () => {
    it("管理者が全員取り消された・環境が食い違うDBを、アプリを経由せず直せる", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "access-recover-"))
        const file = path.join(dir, "access.sqlite")
        const run = (...args: string[]) =>
            execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/access-recover.mjs", ...args], {
                env: { ...process.env, ACCESS_DB_PATH: file },
                encoding: "utf8",
            })
        try {
            // 開発として初期化されたDBを、本番として使いたい（デプロイ順序の事故）
            openAccessDb(file, { environment: "development", seedAdminEmails: [], now: T0 }).close()
            assert.throws(() => openAccessDb(file, { environment: "production", seedAdminEmails: [], now: T0 }))

            run("set-environment", "production")
            run("add-admin", "Rescue@Example.com")
            const db = openAccessDb(file, { environment: "production", seedAdminEmails: [], now: T0 })
            assert.equal(decideAccess(db, "status-hub", "rescue@example.com").allowed, true)
            assert.deepEqual(
                listAudit(db).map((entry) => entry.actor),
                ["system:recovery", "system:recovery"]
            )
            db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
