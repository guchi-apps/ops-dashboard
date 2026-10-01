/**
 * `node:sqlite` の型宣言（使う範囲だけ）。
 *
 * `@types/node` は v20 系で、`node:sqlite` の型を持たない。依存のメジャー更新は避け、
 * アクセス管理（src/lib/access/）が使うメソッドだけを手書きしている。
 */
declare module "node:sqlite" {
    type SqlValue = string | number | bigint | null | Uint8Array

    interface StatementResultingChanges {
        changes: number | bigint
        lastInsertRowid: number | bigint
    }

    class StatementSync {
        run(...params: SqlValue[]): StatementResultingChanges
        get(...params: SqlValue[]): Record<string, SqlValue> | undefined
        all(...params: SqlValue[]): Record<string, SqlValue>[]
    }

    class DatabaseSync {
        constructor(path: string)
        exec(sql: string): void
        prepare(sql: string): StatementSync
        close(): void
    }
}
