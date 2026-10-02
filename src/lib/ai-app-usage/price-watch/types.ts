import type { ModelPrice } from "@/lib/ai-app-usage/models"

/**
 * モデル単価表の定期チェック（#497）で受け渡す型。
 * 画面（クライアント）からも読むため、サーバー専用の処理を import しないこと。
 */

/** 公式情報の取得対象にできる提供元。TypeSafe(Jev)は公開の単価ページが無いため対象外（「公式情報なし」と記録する） */
export type WatchedProvider = "Anthropic" | "OpenAI"

/** 公式の料金ページから読んだ1モデルぶん。`-`（その課金なし）は null で、0とは区別する */
export interface OfficialPrice {
    provider: WatchedProvider
    /** APIのモデルID。表示名しか載っておらずIDを確かめられないときは null（推測しない） */
    id: string | null
    /** 公式の表示名 */
    name: string
    /** 条件付き価格（長文脈のしきい値付きなど）の行は、通常価格として取り込まないため null */
    price: { [K in keyof ModelPrice]: number | null } | null
    /** 課金上の注記（条件・限定提供・提供終了など）。無ければ null */
    condition: string | null
    /** 提供終了しているモデル（追加候補にはしない） */
    retired: boolean
}

export type CandidateKind = "add" | "change" | "verify" | "delisted"

/** 単価表へ反映するかを人が確かめる更新候補 */
export interface PriceCandidate {
    /** 通知の重複抑止に使う。同じ内容なら同じ値で、価格が変わると別の値になる */
    key: string
    kind: CandidateKind
    provider: WatchedProvider
    /** モデルID。確かめられないときは null（画面では「ID未確定」） */
    id: string | null
    name: string
    /** 登録済みの単価。追加候補では null */
    before: ModelPrice | null
    /** 公式の単価。公式が `-`（その課金なし）とした項目は null（0にしない）。条件付きで通常価格が無いときは全体が null */
    after: { [K in keyof ModelPrice]: number | null } | null
    /** 前後で違う項目（価格変更のとき） */
    changedFields: (keyof ModelPrice)[]
    /** 価格の通貨・単位・適用条件 */
    basis: string
    note: string | null
    sourceUrl: string
    checkedAt: string
}

export type ProviderCheckStatus = "ok" | "failed" | "unavailable"

export interface ProviderCheckResult {
    provider: string
    status: ProviderCheckStatus
    /** 失敗・取得対象外の理由（画面に出す短い文）。秘匿値を含めない */
    reason: string | null
    sourceUrls: string[]
    /** 読めたモデル数（status が ok のとき） */
    modelCount: number
    /** 読めなかった行の説明。あれば画面に出す */
    warnings: string[]
}

export type CheckOutcome = "unchanged" | "candidates" | "partial" | "failed"

export interface CheckRun {
    startedAt: string
    finishedAt: string
    outcome: CheckOutcome
    providers: ProviderCheckResult[]
    /** この回に確認できた更新候補の数（取得に失敗した提供元の持ち越しを含まない） */
    candidateCount: number
}
