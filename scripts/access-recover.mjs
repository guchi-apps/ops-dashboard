#!/usr/bin/env node
/**
 * 共通アクセス設定（#489）の復旧CLI。管理者が全員いなくなった・環境名が食い違って全拒否に
 * なったときに、**アプリ・API・ログインを経由せず**、サーバー上でDBを直接直す。
 * Node標準のモジュールだけで動く（依存パッケージ・ビルド不要）。
 *
 *   node scripts/access-recover.mjs show
 *   node scripts/access-recover.mjs add-admin <email>
 *   node scripts/access-recover.mjs set-environment <production|development>
 *
 * 対象のDBは `ACCESS_DB_PATH`（未設定なら ./.data/access.sqlite）。実行にはDBファイルへの
 * 書き込み権限（=サーバーのアプリ実行ユーザー）が要る。変更は監査履歴へ `system:recovery`
 * として残り、StatusHubのログイン判定へは最大30秒以内に効く。
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const STATUS_HUB = "status-hub"
const file = process.env.ACCESS_DB_PATH || path.join(process.cwd(), ".data", "access.sqlite")

function fail(message) {
    console.error(`エラー: ${message}`)
    process.exit(1)
}

const [command, argument] = process.argv.slice(2)
if (!["show", "add-admin", "set-environment"].includes(command ?? "")) {
    fail("使い方: show | add-admin <email> | set-environment <production|development>")
}
if (!existsSync(file)) {
    fail(`DBが見つかりません: ${file}（一度アプリを起動すると作られます。ACCESS_DB_PATH も確かめてください）`)
}

const db = new DatabaseSync(file)
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
const now = new Date().toISOString()

function audit(action, target, before, after) {
    db.prepare("INSERT INTO audit (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)").run(
        now,
        "system:recovery",
        action,
        target,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after)
    )
}

if (command === "show") {
    const environment = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get()?.value
    console.log(`DB: ${file}`)
    console.log(`環境: ${environment ?? "（未初期化）"}`)
    const admins = db
        .prepare(
            `SELECT u.email, u.status FROM users u JOIN grants g ON g.email = u.email
             WHERE g.app_id = ? AND g.permissions LIKE '%"admin"%' ORDER BY u.email`
        )
        .all(STATUS_HUB)
    console.log(`管理者（${admins.length}名）:`)
    for (const admin of admins) console.log(`  ${admin.email}${admin.status === "active" ? "" : "（取り消し済み）"}`)
}

if (command === "add-admin") {
    const email = (argument ?? "").trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("メールアドレスの形式が正しくありません")

    db.exec("BEGIN IMMEDIATE")
    try {
        const before = db.prepare("SELECT status FROM users WHERE email = ?").get(email)
        if (before) db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE email = ?").run(now, email)
        else db.prepare("INSERT INTO users (email, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(email, now, now)
        db.prepare(
            `INSERT INTO grants (email, app_id, permissions) VALUES (?, ?, '["admin"]')
             ON CONFLICT(email, app_id) DO UPDATE SET permissions = '["admin"]'`
        ).run(email, STATUS_HUB)
        db.prepare("UPDATE apps SET version = version + 1 WHERE id = ?").run(STATUS_HUB)
        audit("user.recover-admin", email, before ? { status: before.status } : null, {
            status: "active",
            grants: { [STATUS_HUB]: ["admin"] },
        })
        db.exec("COMMIT")
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
    console.log(`管理者として有効にしました: ${email}（StatusHubへ最大30秒以内に反映されます）`)
}

if (command === "set-environment") {
    if (argument !== "production" && argument !== "development") fail("環境は production か development を指定してください")
    const before = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get()?.value ?? null
    db.exec("BEGIN IMMEDIATE")
    try {
        db.prepare("INSERT INTO meta (key, value) VALUES ('environment', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(argument)
        audit("environment.recover", "meta.environment", { environment: before }, { environment: argument })
        db.exec("COMMIT")
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
    console.log(`環境を ${before ?? "（未設定）"} → ${argument} に直しました。アプリが ACCESS_ENVIRONMENT=${argument} で動いているか確かめてください`)
}

db.close()
