import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { getAllowedEmails } from "@/lib/allowed-emails"

/**
 * 共通アクセス設定のDB（#489）。許可メール・アプリ別の権限・変更履歴を持つ。
 *
 * SQLite（Node標準の `node:sqlite`）を `.data/access.sqlite` に置く。`.data/` は `.gitignore`
 * 済みで、デプロイでも消されない（deploy.yml の `rm -rf` の対象外）。**秘密情報の値は持たない**
 * （アプリ別トークンはSHA-256のハッシュだけ）。
 *
 * 本番と開発の区別は `ACCESS_ENVIRONMENT`（`production` / `development`）で行う。初期化時にDBの
 * `meta` へ記録し、あとから環境変数と食い違えば `AccessEnvironmentMismatchError` を投げて
 * 全拒否にする（開発の設定を本番として配らない・その逆を防ぐ）。
 */

export const ACCESS_ENVIRONMENTS = ["production", "development"] as const
export type AccessEnvironment = (typeof ACCESS_ENVIRONMENTS)[number]

/** StatusHub自身を表すアプリID。権限は固定で、画面からは定義を変えられない */
export const STATUS_HUB_APP_ID = "status-hub"
export const STATUS_HUB_PERMISSIONS = ["member", "admin"] as const
export const ADMIN_PERMISSION = "admin"

export class AccessEnvironmentMismatchError extends Error {
    readonly expected: AccessEnvironment
    readonly actual: string

    constructor(expected: AccessEnvironment, actual: string) {
        super(`アクセス設定DBの環境（${actual}）が ACCESS_ENVIRONMENT（${expected}）と一致しません`)
        this.expected = expected
        this.actual = actual
    }
}

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    token_hash TEXT,
    token_issued_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
    email TEXT NOT NULL REFERENCES users(email),
    app_id TEXT NOT NULL REFERENCES apps(id),
    permissions TEXT NOT NULL,
    PRIMARY KEY (email, app_id)
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    before TEXT,
    after TEXT
);
CREATE TABLE IF NOT EXISTS checkins (
    app_id TEXT PRIMARY KEY REFERENCES apps(id),
    applied_version INTEGER,
    last_seen_at TEXT NOT NULL,
    last_ok_at TEXT,
    last_error TEXT,
    last_error_at TEXT
);
`

export function parseAccessEnvironment(value: string | undefined): AccessEnvironment {
    // 未設定は development。開発が本番を名乗らない側へ倒す
    return value === "production" ? "production" : "development"
}

export function getAccessDbPath(): string {
    return process.env.ACCESS_DB_PATH || path.join(process.cwd(), ".data", "access.sqlite")
}

export type OpenOptions = {
    environment: AccessEnvironment
    /** 初回の初期化でだけ管理者として取り込むメール（`ALLOWED_EMAILS`）。小文字化済みで渡す */
    seedAdminEmails: string[]
    now: Date
}

/**
 * DBを開き、スキーマを整える。初回（`meta` に環境が無い）だけ、StatusHub自身のアプリ定義と
 * `seedAdminEmails` の管理者を作る。環境が食い違えば取り込みも含めて何もせず例外を投げる。
 */
export function openAccessDb(file: string, options: OpenOptions): Db {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)

    try {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        db.exec(SCHEMA)

        const stored = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get()
        if (stored) {
            if (stored.value !== options.environment) {
                throw new AccessEnvironmentMismatchError(options.environment, String(stored.value))
            }
            return db
        }

        seed(db, options)
        return db
    } catch (error) {
        db.close()
        throw error
    }
}

function seed(db: Db, { environment, seedAdminEmails, now }: OpenOptions) {
    const at = now.toISOString()
    db.exec("BEGIN IMMEDIATE")
    try {
        db.prepare("INSERT INTO meta (key, value) VALUES ('environment', ?)").run(environment)
        db.prepare("INSERT INTO apps (id, name, permissions, version, created_at) VALUES (?, ?, ?, 1, ?)").run(
            STATUS_HUB_APP_ID,
            "StatusHub",
            JSON.stringify(STATUS_HUB_PERMISSIONS),
            at
        )

        // 移行: 以前は `ALLOWED_EMAILS` の全員が同じ全権でStatusHubを使えていたため、同じ範囲を保つ
        for (const email of new Set(seedAdminEmails.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
            db.prepare("INSERT INTO users (email, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(
                email,
                at,
                at
            )
            db.prepare("INSERT INTO grants (email, app_id, permissions) VALUES (?, ?, ?)").run(
                email,
                STATUS_HUB_APP_ID,
                JSON.stringify([ADMIN_PERMISSION])
            )
            db.prepare("INSERT INTO audit (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)").run(
                at,
                "system:migration",
                "user.import",
                email,
                null,
                JSON.stringify({ status: "active", grants: { [STATUS_HUB_APP_ID]: [ADMIN_PERMISSION] } })
            )
        }
        db.exec("COMMIT")
    } catch (error) {
        db.exec("ROLLBACK")
        throw error
    }
}

let shared: Db | null = null

/** プロセス内で1つのDBを使い回す。開けなければ例外（呼び出し側は全拒否へ倒す） */
export function getAccessDb(): Db {
    if (shared) return shared

    shared = openAccessDb(getAccessDbPath(), {
        environment: parseAccessEnvironment(process.env.ACCESS_ENVIRONMENT),
        seedAdminEmails: getAllowedEmails(),
        now: new Date(),
    })
    return shared
}
