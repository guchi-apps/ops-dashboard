/**
 * 旧許可リスト（環境変数・1Passwordのフィールド）を共通アクセス設定（#489）へ移すときの、
 * DBに触れない純粋なロジック（#490）。`access-migrate.mjs` から使い、テストは
 * `src/lib/access/migration.test.ts` から相対パスで読む。Node標準のモジュールだけで動く。
 *
 * **出力にメールの実値を含めない。** 結果は件数だけで返す（公開ログ・Issueへ貼っても漏れないように）。
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `access/policy.ts` の `normalizeEmail` と同じ基準（小文字化・前後の空白除去・254文字以内） */
export function normalizeEmail(value) {
    if (typeof value !== "string") return null
    const email = value.trim().toLowerCase()
    return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

/**
 * 旧リストの文字列（カンマ・空白・改行区切り）を、重複を除いた正規化済みメールの配列にする。
 * メールとして読めなかった要素の数は `invalid` で返す（実値は返さない）。
 */
export function parseLegacyList(text) {
    const emails = new Set()
    let invalid = 0
    for (const token of String(text ?? "").split(/[\s,;]+/)) {
        if (token === "") continue
        const email = normalizeEmail(token)
        if (email) emails.add(email)
        else invalid += 1
    }
    return { emails: [...emails].sort(), invalid }
}

/**
 * 取り込みの計画を立てる。DBの現状（`users`: email→status、`grants`: email→対象アプリの権限配列）を
 * 受け、1人ごとに次のどれかへ振り分ける。
 * - `skippedRevoked`: StatusHubで取り消し済み。**旧リストに載っていても戻さない**（取り消しを覆さない）
 * - `unchanged`: すでに対象権限を持つ
 * - `created` / `granted`: 新規登録して付与／既存の有効なユーザーへ付与
 */
export function planImport(legacyEmails, users, grants, permission) {
    const plan = { create: [], grant: [], unchanged: [], skippedRevoked: [] }
    for (const email of legacyEmails) {
        const status = users.get(email)
        if (status === "revoked") plan.skippedRevoked.push(email)
        else if (status === undefined) plan.create.push(email)
        else if ((grants.get(email) ?? []).includes(permission)) plan.unchanged.push(email)
        else plan.grant.push(email)
    }
    return plan
}

/** 取り込み後の権限配列。ほかの権限は残し、対象の権限だけを足す */
export function withPermission(current, permission) {
    return [...new Set([...(current ?? []), permission])].sort()
}

/**
 * 旧リストと新設定の差分。`current` は新設定でそのアプリを使える（有効かつ付与あり）メール。
 * `missing` が旧リストにいて新設定で使えない人（移行の欠落）、`extra` が新設定にだけいる人。
 * 欠落の理由は `users`（email→status）で分ける。
 */
export function diffLegacy(legacyEmails, currentEmails, users) {
    const current = new Set(currentEmails)
    const legacy = new Set(legacyEmails)
    const result = { legacy: legacy.size, current: current.size, common: 0, missing: 0, missingRevoked: 0, missingUnregistered: 0, extra: 0 }
    for (const email of legacy) {
        if (current.has(email)) {
            result.common += 1
            continue
        }
        result.missing += 1
        if (users.get(email) === "revoked") result.missingRevoked += 1
        else if (users.get(email) === undefined) result.missingUnregistered += 1
    }
    for (const email of current) if (!legacy.has(email)) result.extra += 1
    return result
}
