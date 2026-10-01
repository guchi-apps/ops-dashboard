import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { diffLegacy, parseLegacyList, planImport, withPermission } from "../../../scripts/access-migration-core.mjs"
import { openAccessDb, type Db } from "@/lib/access/db"
import { decideAccess, getApp, listAudit, upsertApp, upsertUser } from "@/lib/access/policy"

const T0 = new Date("2026-10-01T00:00:00.000Z")

describe("旧リストの読み取り（core）", () => {
    it("区切り・大文字小文字・重複を吸収し、読めない要素は件数だけ数える", () => {
        const { emails, invalid } = parseLegacyList(" A@Example.com, b@example.com;\nA@example.com  not-an-email ")
        assert.deepEqual(emails, ["a@example.com", "b@example.com"])
        assert.equal(invalid, 1)
    })

    it("planImport は取り消し済みを戻さず、すでに付与済みの人を変えない", () => {
        const users = new Map([
            ["revoked@example.com", "revoked"],
            ["done@example.com", "active"],
            ["other@example.com", "active"],
        ])
        const grants = new Map([["done@example.com", ["viewer"]]])
        const plan = planImport(
            ["revoked@example.com", "done@example.com", "other@example.com", "new@example.com"],
            users,
            grants,
            "viewer"
        )
        assert.deepEqual(plan, {
            create: ["new@example.com"],
            grant: ["other@example.com"],
            unchanged: ["done@example.com"],
            skippedRevoked: ["revoked@example.com"],
        })
    })

    it("withPermission は既存の権限を残して足す", () => {
        assert.deepEqual(withPermission(["viewer"], "editor"), ["editor", "viewer"])
        assert.deepEqual(withPermission(null, "viewer"), ["viewer"])
    })

    it("diffLegacy は欠落を理由別に数え、メールの実値を返さない", () => {
        const users = new Map([
            ["gone@example.com", "revoked"],
            ["ok@example.com", "active"],
        ])
        const result = diffLegacy(["gone@example.com", "ok@example.com", "none@example.com"], ["ok@example.com", "extra@example.com"], users)
        assert.deepEqual(result, { legacy: 3, current: 2, common: 1, missing: 2, missingRevoked: 1, missingUnregistered: 1, extra: 1 })
    })
})

describe("移行CLI（access-migrate.mjs）", () => {
    function setup() {
        const dir = mkdtempSync(path.join(tmpdir(), "access-migrate-"))
        const file = path.join(dir, "access.sqlite")
        const db = openAccessDb(file, { environment: "development", seedAdminEmails: ["owner@example.com"], now: T0 })
        upsertApp(db, "test", { id: "trainroute", name: "trainroute", permissions: ["viewer", "editor"] }, T0)
        upsertApp(db, "test", { id: "dayspan", name: "dayspan", permissions: ["viewer"] }, T0)
        upsertUser(db, "test", { email: "kept@example.com", grants: { dayspan: ["viewer"], trainroute: ["editor"] } }, T0)
        upsertUser(db, "test", { email: "revoked@example.com", status: "revoked", grants: { trainroute: ["viewer"] } }, T0)
        const run = (input: string, ...args: string[]) =>
            spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/access-migrate.mjs", ...args], {
                env: { ...process.env, ACCESS_DB_PATH: file },
                input,
                encoding: "utf8",
            })
        const cleanup = () => {
            db.close()
            rmSync(dir, { recursive: true, force: true })
        }
        return { db, run, cleanup }
    }

    const legacy = "Kept@Example.com, revoked@example.com\nnew@example.com"

    const grantsOf = (db: Db, email: string) => {
        const decision = decideAccess(db, "trainroute", email)
        return { allowed: decision.allowed, permissions: decision.allowed ? decision.permissions : [] }
    }

    it("対象アプリの付与だけを足し、他アプリの付与と取り消しは触らず、監査へ system:migration を残す", () => {
        const { db, run, cleanup } = setup()
        try {
            const before = getApp(db, "trainroute")!.version
            const otherBefore = getApp(db, "dayspan")!.version
            const result = run(legacy, "import", "trainroute", "viewer")
            assert.equal(result.status, 0, result.stderr)
            assert.match(result.stdout, /新規登録して付与: 1件 \/ 既存ユーザーへ付与: 1件/)
            assert.match(result.stdout, /取り消し済みのためスキップ: 1件/)
            assert.doesNotMatch(result.stdout, /@/)

            // 既存の権限は残り、他アプリの付与も変わらない
            assert.deepEqual(grantsOf(db, "kept@example.com"), { allowed: true, permissions: ["editor", "viewer"] })
            assert.equal(decideAccess(db, "dayspan", "kept@example.com").allowed, true)
            assert.equal(grantsOf(db, "new@example.com").allowed, true)
            // 取り消し済みは戻らない
            assert.equal(grantsOf(db, "revoked@example.com").allowed, false)

            assert.equal(getApp(db, "trainroute")!.version, before + 1)
            assert.equal(getApp(db, "dayspan")!.version, otherBefore)
            const migrated = listAudit(db).filter((entry) => entry.actor === "system:migration" && entry.target !== "owner@example.com")
            assert.equal(migrated.length, 2)
        } finally {
            cleanup()
        }
    })

    it("再実行しても版は進まず、監査も増えない（冪等）", () => {
        const { db, run, cleanup } = setup()
        try {
            assert.equal(run(legacy, "import", "trainroute", "viewer").status, 0)
            const version = getApp(db, "trainroute")!.version
            const audits = listAudit(db).length
            const again = run(legacy, "import", "trainroute", "viewer")
            assert.equal(again.status, 0, again.stderr)
            assert.match(again.stdout, /新規登録して付与: 0件 \/ 既存ユーザーへ付与: 0件/)
            assert.equal(getApp(db, "trainroute")!.version, version)
            assert.equal(listAudit(db).length, audits)
        } finally {
            cleanup()
        }
    })

    it("--dry-run は付与・版・監査のいずれも変えず、同じ件数を報告する", () => {
        const { db, run, cleanup } = setup()
        try {
            const version = getApp(db, "trainroute")!.version
            const audits = listAudit(db).length
            const result = run(legacy, "import", "trainroute", "viewer", "--dry-run")
            assert.equal(result.status, 0, result.stderr)
            assert.match(result.stdout, /dry-run/)
            assert.match(result.stdout, /新規登録して付与: 1件 \/ 既存ユーザーへ付与: 1件/)
            assert.equal(grantsOf(db, "new@example.com").allowed, false)
            assert.equal(getApp(db, "trainroute")!.version, version)
            assert.equal(listAudit(db).length, audits)
        } finally {
            cleanup()
        }
    })

    it("未登録のアプリ・未対応の権限・空の入力はエラーにして何も書かない", () => {
        const { db, run, cleanup } = setup()
        try {
            const audits = listAudit(db).length
            assert.equal(run(legacy, "import", "no-such-app", "viewer").status, 1)
            assert.equal(run(legacy, "import", "dayspan", "editor").status, 1)
            assert.equal(run("  \n", "import", "trainroute", "viewer").status, 1)
            assert.equal(listAudit(db).length, audits)
        } finally {
            cleanup()
        }
    })

    it("diff は欠落があれば終了コード2で、件数だけを出す。取り込み後は0になる", () => {
        const { run, cleanup } = setup()
        try {
            const missing = run(legacy, "diff", "trainroute")
            assert.equal(missing.status, 2)
            assert.match(missing.stdout, /欠落: 2件（取り消し済み 1・未登録 1）/)
            assert.doesNotMatch(missing.stdout, /@/)

            assert.equal(run(legacy, "import", "trainroute", "viewer").status, 0)
            // 取り消し済みは戻さないので、その1件だけが欠落として残る
            const after = run(legacy, "diff", "trainroute")
            assert.equal(after.status, 2)
            assert.match(after.stdout, /欠落: 1件（取り消し済み 1・未登録 0）/)
            const clean = run("kept@example.com, new@example.com", "diff", "trainroute")
            assert.equal(clean.status, 0, clean.stdout)
        } finally {
            cleanup()
        }
    })
})
