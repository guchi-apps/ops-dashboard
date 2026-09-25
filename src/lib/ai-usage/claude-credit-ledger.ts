import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { formatMoney } from "@/lib/ai-usage/common"
import type {
    AiProviderCredit,
    AiUsageSnapshot,
    ClaudeCreditLedgerView,
    ClaudeCreditPurchaseView,
} from "@/types/ai-usage"

/**
 * Claudeのクレジット購入と残高を手で記録する台帳（#252）。
 *
 * **claude.ai の非公開API（`/api/organizations/{org}/prepaid/credits` など）はサーバーから叩けない。**
 * sessionKey cookie を付けても、cookie無しでも、Cloudflareのボット判定で 403
 * （`cf-mitigated: challenge`）が返り、認証の手前で止まる。購入履歴も残高も取れないため、
 * 購入（日付・金額）と「ある時点の残高」を画面から登録し、そこからの使用額を差し引いて残高を推定する。
 *
 * 使用額は `extra_usage.used_credits`（当月の累計）の観測から積み上げる。月が替わると値が
 * 小さくなるので、減ったら「リセットされた」とみなしてその値をそのまま足す。暦の月で区切らないのは、
 * 提供元がどのタイムゾーンで月を切っているかに依存させないため。
 */

/**
 * 台帳の単位と保存先。Claudeは1クレジット = 1USD（セント単位）。
 * TypeSafe（Jev）の台帳（#426）も同じ仕組みを使うため、通貨・桁数・保存先だけを差し替えられる。
 * Jevは1回の消費が数セント未満になるため、最小単位を小さく取る。
 */
export interface LedgerConfig {
    currency: string
    decimals: number
    envVar: string
    fileName: string
    /** 観測値が通算の累計なら true。減ったときはリセットではなく集計の欠けなので、足さずに基準だけ置き直す */
    cumulative?: boolean
}

export const CLAUDE_LEDGER: LedgerConfig = {
    currency: "USD",
    decimals: 2,
    envVar: "CLAUDE_CREDIT_LEDGER_PATH",
    fileName: "claude-credit-ledger.json",
}

interface StoredPurchase {
    id: string
    /** 購入日（YYYY-MM-DD） */
    date: string
    amountMinor: number
    recordedAt: string
}

interface StoredCorrection {
    balanceMinor: number
    /** 補正した時刻（ISO 8601） */
    at: string
    /** 補正した日（実行環境の暦で YYYY-MM-DD）。この日までの購入は残高に含まれているものとして扱う */
    date: string
    /** 補正した時点の使用額の累計 */
    usedTotalMinor: number
}

export interface LedgerState {
    purchases: StoredPurchase[]
    correction: StoredCorrection | null
    /** 観測を始めてからの使用額の累計（最小単位） */
    usedTotalMinor: number
    /** 最後に観測した当月の使用額。リセットの検出に使う。未観測なら null */
    lastObservedMinor: number | null
}

const EMPTY_STATE: LedgerState = {
    purchases: [],
    correction: null,
    usedTotalMinor: 0,
    lastObservedMinor: null,
}

function getStatePath(config: LedgerConfig): string {
    return process.env[config.envVar] || path.join(process.cwd(), ".data", config.fileName)
}

export async function readState(config: LedgerConfig = CLAUDE_LEDGER): Promise<LedgerState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(config), "utf8"))
        if (!parsed || typeof parsed !== "object") return { ...EMPTY_STATE }

        const state = parsed as Partial<LedgerState>
        return {
            purchases: Array.isArray(state.purchases) ? state.purchases : [],
            correction: state.correction ?? null,
            usedTotalMinor: typeof state.usedTotalMinor === "number" ? state.usedTotalMinor : 0,
            lastObservedMinor:
                typeof state.lastObservedMinor === "number" ? state.lastObservedMinor : null,
        }
    } catch {
        return { ...EMPTY_STATE }
    }
}

async function writeState(state: LedgerState, config: LedgerConfig): Promise<void> {
    const file = getStatePath(config)
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/**
 * ファイルへの read-modify-write を直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/** 実行環境の暦で YYYY-MM-DD にする（`claude.ts` の月初リセットと同じ暦を使う） */
function localDateKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    return `${date.getFullYear()}-${month}-${day}`
}

/** 購入したクレジットの有効期限は購入日から1年 */
function expiresOn(date: string): string {
    const [year, rest] = [Number(date.slice(0, 4)), date.slice(4)]
    return `${year + 1}${rest}`
}

export function isValidDateKey(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

/** 画面で入力された金額（USD）を最小単位へ。負の値や桁の多すぎる値は受け付けない */
export function toMinorUnits(amount: number, config: LedgerConfig = CLAUDE_LEDGER): number | null {
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null
    return Math.round(amount * 10 ** config.decimals)
}

/** 取得のたびに当月の使用額を観測し、累計へ積む */
export function recordCreditUsage(usedMinor: number, config: LedgerConfig): Promise<void> {
    if (!Number.isFinite(usedMinor) || usedMinor < 0) return Promise.resolve()

    return serialize(async () => {
        const state = await readState(config)
        const last = state.lastObservedMinor
        if (last === usedMinor) return

        // 減っていれば月が替わってリセットされた。前の月の取りこぼし（最後の観測から月末まで）は拾えない
        const increase = last === null ? 0 : usedMinor >= last ? usedMinor - last : config.cumulative ? 0 : usedMinor
        state.usedTotalMinor += increase
        state.lastObservedMinor = usedMinor
        await writeState(state, config)
    })
}

export function addCreditPurchase(date: string, amountMinor: number, config: LedgerConfig): Promise<void> {
    return serialize(async () => {
        const state = await readState(config)
        state.purchases.push({
            id: randomUUID(),
            date,
            amountMinor,
            recordedAt: new Date().toISOString(),
        })
        await writeState(state, config)
    })
}

/** 見つからなければ false */
export function removeCreditPurchase(id: string, config: LedgerConfig): Promise<boolean> {
    return serialize(async () => {
        const state = await readState(config)
        const next = state.purchases.filter((purchase) => purchase.id !== id)
        if (next.length === state.purchases.length) return false

        state.purchases = next
        await writeState(state, config)
        return true
    })
}

/**
 * Claude.aiの画面に出ている残高で推定をやり直す。
 * 呼ぶ前に使用額を観測しておくこと（補正時点の累計を起点にするため）。
 */
export function correctCreditBalance(balanceMinor: number, config: LedgerConfig): Promise<void> {
    return serialize(async () => {
        const state = await readState(config)
        const now = new Date()
        state.correction = {
            balanceMinor,
            at: now.toISOString(),
            date: localDateKey(now),
            usedTotalMinor: state.usedTotalMinor,
        }
        await writeState(state, config)
    })
}

function money(minor: number, config: LedgerConfig): string {
    return formatMoney(minor, config.currency, config.decimals)
}

/** 台帳から画面に出す値を組み立てる */
export function describeLedger(
    state: LedgerState,
    now = new Date(),
    config: LedgerConfig = CLAUDE_LEDGER
): ClaudeCreditLedgerView {
    const today = localDateKey(now)

    const purchases: ClaudeCreditPurchaseView[] = [...state.purchases]
        .sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt))
        .map((purchase) => {
            const expires = expiresOn(purchase.date)
            return {
                id: purchase.id,
                date: purchase.date,
                amount: purchase.amountMinor / 10 ** config.decimals,
                expiresOn: expires,
                expired: expires <= today,
            }
        })

    const activeMinor = state.purchases
        .filter((purchase) => expiresOn(purchase.date) > today)
        .reduce((sum, purchase) => sum + purchase.amountMinor, 0)

    const correction = state.correction
    let balanceText: string | null = null
    let balanceMinor: number | null = null
    if (correction) {
        // 補正した日までの購入は、入力した残高に含まれているものとして扱う
        const purchasedAfter = state.purchases
            .filter((purchase) => purchase.date > correction.date)
            .reduce((sum, purchase) => sum + purchase.amountMinor, 0)
        const usedAfter = Math.max(0, state.usedTotalMinor - correction.usedTotalMinor)
        balanceMinor = Math.max(0, correction.balanceMinor + purchasedAfter - usedAfter)
        balanceText = money(balanceMinor, config)
    }

    return {
        purchases,
        activePurchasedText: state.purchases.length > 0 ? money(activeMinor, config) : null,
        balanceText,
        balanceMinor,
        correctedAt: correction?.at ?? null,
        correctedBalanceText: correction ? money(correction.balanceMinor, config) : null,
    }
}

/**
 * 購入済みでまだ使っていない残高を、バー（月の上限を100%とする）の幅にしたもの。
 * 使用済みの右隣に塗るため、上限の残りを超える分は切る（残高が上限より多いと右へはみ出すため）。
 * 上限が無い・通貨が台帳と違う・残高がゼロのときは塗るものが無いので undefined
 */
export function getReservedPercent(
    credit: AiProviderCredit,
    balanceMinor: number | null
): number | undefined {
    const monthly = credit.monthly
    if (balanceMinor === null || balanceMinor <= 0 || credit.usedPercent === null) return undefined
    if (!monthly || monthly.limitMinor === null || monthly.limitMinor <= 0) return undefined
    if (monthly.currency !== CLAUDE_LEDGER.currency || monthly.decimals !== CLAUDE_LEDGER.decimals) return undefined

    const balancePercent = (balanceMinor / monthly.limitMinor) * 100
    const percent = Math.min(balancePercent, 100 - credit.usedPercent)
    return percent > 0 ? Math.round(percent * 10) / 10 : undefined
}

export const recordClaudeCreditUsage = (usedMinor: number) => recordCreditUsage(usedMinor, CLAUDE_LEDGER)
export const addClaudeCreditPurchase = (date: string, amountMinor: number) =>
    addCreditPurchase(date, amountMinor, CLAUDE_LEDGER)
export const removeClaudeCreditPurchase = (id: string) => removeCreditPurchase(id, CLAUDE_LEDGER)
export const correctClaudeCreditBalance = (balanceMinor: number) =>
    correctCreditBalance(balanceMinor, CLAUDE_LEDGER)

function withLedger(
    credit: AiProviderCredit | undefined,
    ledger: ClaudeCreditLedgerView
): AiProviderCredit {
    const purchasedText = ledger.activePurchasedText
        ? `購入 ${ledger.activePurchasedText}（有効分）`
        : null

    if (!credit) {
        return {
            valueText: ledger.balanceText ? `残り ${ledger.balanceText}` : "未記録",
            usedPercent: null,
            detailText: purchasedText,
            resetsAt: null,
            ledger,
        }
    }

    return {
        ...credit,
        valueText: ledger.balanceText ? `残り ${ledger.balanceText}` : credit.valueText,
        detailText: [credit.detailText, purchasedText].filter(Boolean).join(" · ") || null,
        ledger,
        reservedPercent: getReservedPercent(credit, ledger.balanceMinor),
    }
}

/**
 * スナップショットのClaudeのクレジット枠へ台帳の値を載せる。
 * 台帳の編集をすぐ画面へ出すため、提供元の取得結果をキャッシュから返す回も毎回載せ直す
 * （キャッシュ自体は書き換えず、コピーへ載せる）。提供元の取得に失敗した回も台帳の値と
 * 記録フォームは出す。台帳は提供元に依存しないため。
 */
export async function applyClaudeCreditLedger(snapshot: AiUsageSnapshot): Promise<AiUsageSnapshot> {
    if (!snapshot.providers.some((provider) => provider.id === "claude")) return snapshot

    const ledger = describeLedger(await readState(CLAUDE_LEDGER))

    return {
        ...snapshot,
        providers: snapshot.providers.map((provider) =>
            provider.id === "claude" ? { ...provider, credit: withLedger(provider.credit, ledger) } : provider
        ),
    }
}
