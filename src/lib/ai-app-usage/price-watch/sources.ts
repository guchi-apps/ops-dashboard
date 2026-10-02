import type { OfficialPrice } from "@/lib/ai-app-usage/price-watch/types"

/**
 * 公式の料金ページ（Markdown）から単価を読む（#497）。純粋関数だけで、取得は `run.ts` が担う。
 *
 * **公式のAPIに単価は無い**（モデル一覧APIは単価を返さない）ため、公式ドキュメントの表を読む。
 * 表の形が想定と違うときは推測で読み進めず、`PriceParseError` で失敗にする（「変更なし」と混同しない）。
 */

export const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md"
export const ANTHROPIC_MODELS_URL = "https://platform.claude.com/docs/en/models/overview.md"
export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md"

export class PriceParseError extends Error {}

export interface ParsedPrices {
    prices: OfficialPrice[]
    /** 読み飛ばした行の説明 */
    warnings: string[]
}

function splitRow(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
}

const isTableRow = (line: string) => line.trim().startsWith("|")

/** `$12.50 / MTok<sup>1</sup>` や `$0.125` の金額。`-`（その課金なし）は null、読めなければ undefined */
function parseMoney(cell: string): number | null | undefined {
    const text = cell.replace(/<[^>]*>/g, "").trim()
    if (text === "-" || text === "—") return null
    const match = text.match(/^\$\s*([\d,]+(?:\.\d+)?)/)
    if (!match) return undefined
    const value = Number(match[1].replace(/,/g, ""))
    return Number.isFinite(value) ? value : undefined
}

/** 見出し行から最初の `###`/`##` までの、見出し直下の表の行を返す（見出しが無ければ null） */
function tableUnder(lines: string[], heading: string): string[] | null {
    const start = lines.findIndex((line) => line.trim() === heading)
    if (start === -1) return null

    const rows: string[] = []
    for (const line of lines.slice(start + 1)) {
        if (isTableRow(line)) rows.push(line)
        else if (rows.length > 0) break
        else if (/^#{1,6}\s/.test(line)) break
    }
    return rows.length > 0 ? rows : null
}

/**
 * OpenAIの料金ページ。**節見出し `### Standard pricing data` 直下の表だけを読む。**
 * Batch・Flex・Fast・Ultrafastは同じ列構成の別の節で、列見出しでは区別できず、取り違えると別の課金区分の
 * 単価を通常価格として取り込んでしまう。取り込むのは短文脈の入力・キャッシュ読み出し・書き込み・出力のみ
 * （長文脈の列は適用条件が付くため読まない）。
 */
export function parseOpenAiPricing(markdown: string): ParsedPrices {
    const rows = tableUnder(markdown.split("\n"), "### Standard pricing data")
    if (!rows) throw new PriceParseError("料金表（Standard）の節が見つかりません")

    const header = splitRow(rows[0]).map((cell) => cell.toLowerCase())
    const expected = [
        "model",
        "short context input",
        "short context cached input",
        "short context cache writes",
        "short context output",
    ]
    if (!expected.every((name, index) => header[index] === name)) {
        throw new PriceParseError("料金表の列見出しが想定と異なります")
    }

    const prices: OfficialPrice[] = []
    const warnings: string[] = []
    for (const row of rows.slice(2)) {
        const cells = splitRow(row)
        const nameCell = cells[0]
        if (!nameCell) continue

        // `gpt-5.5 (<272K context length)` のように条件が付く行は、通常価格ではないため単価を取り込まない
        const conditionMatch = nameCell.match(/^(\S+)\s*\((.+)\)$/)
        const id = (conditionMatch ? conditionMatch[1] : nameCell).trim()
        const condition = conditionMatch ? conditionMatch[2].trim() : null

        const [input, cacheRead, cacheWrite, output] = cells.slice(1, 5).map(parseMoney)
        if (
            input === undefined ||
            cacheRead === undefined ||
            cacheWrite === undefined ||
            output === undefined ||
            input === null ||
            output === null
        ) {
            warnings.push(`${id}: 単価を読み取れないため読み飛ばしました`)
            continue
        }

        prices.push({
            provider: "OpenAI",
            id,
            name: id,
            price: condition ? null : { input, output, cacheWrite, cacheRead },
            condition,
            retired: false,
        })
    }

    if (prices.length === 0) throw new PriceParseError("料金表にモデルの行がありません")
    return { prices, warnings }
}

/** `[Claude Opus 5.5](https://…)` などのリンクを表示文字だけにする */
const stripMarkdown = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "")

/**
 * Anthropicのモデル概要ページ（モデルが列に並ぶ転置表）から「表示名 → APIのモデルID」を作る。
 * 料金表には表示名しか載っていないため、IDの根拠はここだけ。**対応が取れない名前は推測しない。**
 */
export function parseAnthropicModelIds(markdown: string): Map<string, string> {
    const lines = markdown.split("\n").filter(isTableRow)
    const nameRow = lines.find((line) => splitRow(line)[0] === "Model page")
    const idRow = lines.find((line) => splitRow(line)[0] === "Claude API ID")
    if (!nameRow || !idRow) throw new PriceParseError("モデル概要の表（Model page / Claude API ID）が見つかりません")

    const names = splitRow(nameRow).slice(1).map((cell) => stripMarkdown(cell).trim())
    const ids = splitRow(idRow).slice(1).map((cell) => cell.replace(/`/g, "").trim())
    if (names.length === 0 || names.length !== ids.length) {
        throw new PriceParseError("モデル概要の表の列数が合いません")
    }

    return new Map(names.map((name, index) => [name, ids[index]]))
}

/**
 * Anthropicの料金ページ。`## Model pricing` 直下の標準API価格の表を読む。
 * キャッシュ書き込みは5分のもの（1時間書き込み・Batch・fast modeなど別の課金条件は読まない）、
 * キャッシュ読み出しは「Cache hits and refreshes」の列。
 */
export function parseAnthropicPricing(markdown: string, idByName: ReadonlyMap<string, string>): ParsedPrices {
    const rows = tableUnder(markdown.split("\n"), "## Model pricing")
    if (!rows) throw new PriceParseError("料金表（Model pricing）の節が見つかりません")

    const header = splitRow(rows[0]).map((cell) => cell.toLowerCase())
    const expected = ["model", "base input tokens", "5m cache writes", "1h cache writes", "cache hits and refreshes", "output tokens"]
    if (!expected.every((name, index) => header[index] === name)) {
        throw new PriceParseError("料金表の列見出しが想定と異なります")
    }

    const prices: OfficialPrice[] = []
    const warnings: string[] = []
    for (const row of rows.slice(2)) {
        const cells = splitRow(row)
        const rawName = cells[0] ?? ""
        // `Claude Opus 4 ([retired, except on …](url))` の括弧は提供状況の注記
        const noteMatch = stripMarkdown(rawName).match(/^(.*?)\s*\((.+)\)\s*$/)
        const name = (noteMatch ? noteMatch[1] : stripMarkdown(rawName)).trim()
        const note = noteMatch ? noteMatch[2].trim() : null
        if (!name) continue

        const [input, cacheWrite, , cacheRead, output] = cells.slice(1, 6).map(parseMoney)
        if (
            input === undefined ||
            cacheWrite === undefined ||
            cacheRead === undefined ||
            output === undefined ||
            input === null ||
            output === null
        ) {
            warnings.push(`${name}: 単価を読み取れないため読み飛ばしました`)
            continue
        }

        const retired = /retired/i.test(note ?? "")
        prices.push({
            provider: "Anthropic",
            id: idByName.get(name) ?? null,
            name,
            price: { input, output, cacheWrite, cacheRead },
            condition: note ? (retired ? "提供終了" : /limited/i.test(note) ? "限定提供（招待制）" : note) : null,
            retired,
        })
    }

    if (prices.length === 0) throw new PriceParseError("料金表にモデルの行がありません")
    return { prices, warnings }
}
