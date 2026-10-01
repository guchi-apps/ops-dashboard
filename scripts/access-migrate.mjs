#!/usr/bin/env node
/**
 * 旧許可リストを共通アクセス設定（#489）へ取り込む・移行前後を比べるCLI（#490）。
 * 本番サーバーで動くよう、Node標準のモジュールだけの自己完結にしている（デプロイのアーカイブに
 * `src/` は入らない）。判定そのものは `access-migration-core.mjs`（DBに触れない）に置く。
 *
 *   <旧リスト> | node scripts/access-migrate.mjs import <appId> <権限> [--dry-run]
 *   <旧リスト> | node scripts/access-migrate.mjs diff <appId>
 *
 * 旧リストは標準入力から読む（カンマ・空白・改行区切り）。**環境変数やシェルの履歴に値を残さない**よう、
 * `op read ... | node ...` のようにパイプで渡す。**出力は件数だけで、メールの実値は出さない。**
 *
 * `import` の規則（管理画面の `upsertUser` と同じ書き込み規則を守る）:
 * - 権限は、そのアプリが対応する権限（`apps.permissions`）だけ。未登録のアプリ・未対応の権限はエラー
 * - 対象アプリの付与だけを足す。**ほかのアプリの付与・既存の権限は触らない**
 * - StatusHubで `revoked` のユーザーは**戻さずスキップ**して件数を報告する
 * - 実際に変わったときだけ対象アプリの版を1つ進める（再実行しても進まない）。監査履歴へ `system:migration`
 * - `--dry-run` は何も書かず、同じ件数を報告する
 *
 * `diff` は旧リストにいて新設定で使えない人（欠落）と、新設定にだけいる人の件数を出す。欠落があれば
 * 終了コード2（切替前に0であることを確かめる）。対象のDBは `ACCESS_DB_PATH`（未設定なら ./.data/access.sqlite）。
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { diffLegacy, parseLegacyList, planImport, withPermission } from "./access-migration-core.mjs"

const ACTOR = "system:migration"
const file = process.env.ACCESS_DB_PATH || path.join(process.cwd(), ".data", "access.sqlite")

function fail(message) {
    console.error(`エラー: ${message}`)
    process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const [command, appId, permission] = args.filter((arg) => !arg.startsWith("--"))

if (command !== "import" && command !== "diff") {
    fail("使い方: <旧リスト> | import <appId> <権限> [--dry-run]  /  <旧リスト> | diff <appId>")
}
if (!appId) fail("アプリIDを指定してください")
if (command === "import" && !permission) fail("付与する権限を指定してください")
if (command === "diff" && dryRun) fail("--dry-run は import だけに指定できます")
if (!existsSync(file)) {
    fail(`DBが見つかりません: ${file}（一度アプリを起動すると作られます。ACCESS_DB_PATH も確かめてください）`)
}

let input
try {
    input = readFileSync(0, "utf8")
} catch {
    fail("旧リストを標準入力から読めませんでした（パイプで渡してください）")
}
const legacy = parseLegacyList(input)
if (legacy.emails.length === 0) fail("旧リストにメールアドレスがありません（空の入力では何もしません）")

const db = new DatabaseSync(file)
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")

const app = db.prepare("SELECT id, permissions, version FROM apps WHERE id = ?").get(appId)
if (!app) fail(`未登録のアプリです: ${appId}（先に管理画面の「アプリ」タブで登録してください）`)
const supported = JSON.parse(app.permissions)

const users = new Map(db.prepare("SELECT email, status FROM users").all().map((row) => [row.email, row.status]))
const grants = new Map(
    db
        .prepare("SELECT email, permissions FROM grants WHERE app_id = ?")
        .all(appId)
        .map((row) => [row.email, JSON.parse(row.permissions)])
)

if (command === "diff") {
    const current = [...grants.entries()].filter(([email, list]) => users.get(email) === "active" && list.length > 0).map(([email]) => email)
    const result = diffLegacy(legacy.emails, current, users)
    console.log(`アプリ: ${appId}（DB: ${file}）`)
    console.log(`旧リスト: ${result.legacy}件（読めなかった要素 ${legacy.invalid}件）`)
    console.log(`新設定で使える人: ${result.current}件`)
    console.log(`共通: ${result.common}件 / 欠落: ${result.missing}件（取り消し済み ${result.missingRevoked}・未登録 ${result.missingUnregistered}） / 新設定のみ: ${result.extra}件`)
    db.close()
    process.exit(result.missing > 0 ? 2 : 0)
}

if (!supported.includes(permission)) {
    fail(`${appId} が対応していない権限です: ${permission}（対応: ${supported.join(", ")}）`)
}

const plan = planImport(legacy.emails, users, grants, permission)
const changed = plan.create.length + plan.grant.length

if (!dryRun && changed > 0) {
    const now = new Date().toISOString()
    db.exec("BEGIN IMMEDIATE")
    try {
        for (const email of plan.create) {
            db.prepare("INSERT INTO users (email, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(email, now, now)
        }
        for (const email of [...plan.create, ...plan.grant]) {
            const before = grants.get(email) ?? null
            const after = withPermission(before, permission)
            db.prepare(
                `INSERT INTO grants (email, app_id, permissions) VALUES (?, ?, ?)
                 ON CONFLICT(email, app_id) DO UPDATE SET permissions = excluded.permissions`
            ).run(email, appId, JSON.stringify(after))
            if (!users.has(email)) users.set(email, "active")
            else db.prepare("UPDATE users SET updated_at = ? WHERE email = ?").run(now, email)
            const created = plan.create.includes(email)
            db.prepare("INSERT INTO audit (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)").run(
                now,
                ACTOR,
                created ? "user.create" : "user.update",
                email,
                created ? null : JSON.stringify({ status: "active", grants: { [appId]: before ?? [] } }),
                JSON.stringify({ status: "active", grants: { [appId]: after } })
            )
        }
        db.prepare("UPDATE apps SET version = version + 1 WHERE id = ?").run(appId)
        db.exec("COMMIT")
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
}

console.log(`${dryRun ? "【dry-run: 何も書いていません】" : ""}アプリ: ${appId} / 権限: ${permission}`)
console.log(`旧リスト: ${legacy.emails.length}件（読めなかった要素 ${legacy.invalid}件）`)
console.log(`新規登録して付与: ${plan.create.length}件 / 既存ユーザーへ付与: ${plan.grant.length}件 / すでに付与済み: ${plan.unchanged.length}件`)
console.log(`取り消し済みのためスキップ: ${plan.skippedRevoked.length}件（戻していません）`)
if (!dryRun && changed > 0) console.log(`${appId} の版を進めました。管理画面で反映状況が「反映済み」になることを確かめてください`)

db.close()
