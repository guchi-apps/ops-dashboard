#!/usr/bin/env node
/**
 * npm version の lifecycle 用: changelog 先頭に新バージョンのエントリを追加する。
 *
 * リリース自動化ワークフロー（release-develop-to-main.yml）は、developへ取り込まれた
 * 差分から利用者向けの更新履歴を生成し、環境変数 RELEASE_CHANGELOG で渡してくる。
 * 設定されていればその内容を changes へ反映する。未設定・空のとき（ローカルで
 * `npm version` を叩いた場合など）は、従来どおり手で埋めるための枠だけを作る。
 *
 * **依存関係に触れてはいけない。** 共有ワークフローはバージョンbumpのために
 * npm ci を実行しないため、Node標準モジュールだけで完結させる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const changelogPath = join(__dirname, "../src/data/changelog.ts");

export const CHANGELOG_PLACEHOLDER = "（変更内容を追記してください）";

/**
 * RELEASE_CHANGELOG の文面を changes 配列へ整形する。
 * 生成される文面は箇条書き・段落のどちらもありうるため、行単位に分解し、
 * 箇条書き記号と番号を落として1行1項目にそろえる。
 */
export function parseReleaseChangelog(raw) {
    return (raw ?? "")
        .split("\n")
        .map((line) => line.trim().replace(/^(?:[-*・]|\d+[.)])\s*/, "").trim())
        .filter((line) => line !== "")
}

// changes は生成された文面をそのまま埋め込むため、TypeScriptの文字列リテラルを
// 壊さないようにエスケープする。
function escapeForTs(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function insertChangelogEntry(content, version, date, changes = []) {
    if (content.includes(`version: "${version}"`)) {
        return { content, inserted: false }
    }

    const marker = "export const changelog: ChangelogEntry[] = ["
    const index = content.indexOf(marker)
    if (index === -1) {
        throw new Error("changelog marker not found in changelog.ts")
    }

    const items = changes.length > 0 ? changes : [CHANGELOG_PLACEHOLDER]
    const insertAt = index + marker.length
    const entry = `
    {
        version: "${version}",
        date: "${date}",
        changes: [
${items.map((item) => `            "${escapeForTs(item)}",`).join("\n")}
        ],
    },`

    return {
        content: `${content.slice(0, insertAt)}${entry}${content.slice(insertAt)}`,
        inserted: true,
    }
}

function todayJst() {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
        new Date()
    )
}

function main() {
    const version = process.env.npm_package_version
    if (!version) {
        throw new Error("npm_package_version is not set (run via npm version)")
    }

    const changes = parseReleaseChangelog(process.env.RELEASE_CHANGELOG)
    const original = readFileSync(changelogPath, "utf8")
    const { content, inserted } = insertChangelogEntry(
        original,
        version,
        todayJst(),
        changes
    )

    if (!inserted) {
        console.log(`changelog.ts already has version ${version}; skipping.`)
        return
    }

    writeFileSync(changelogPath, content, "utf8")
    if (changes.length > 0) {
        console.log(
            `Added changelog entry for v${version} (${changes.length} change(s))`
        )
    } else {
        console.log(`Added changelog stub for v${version}`)
    }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
    main()
}
