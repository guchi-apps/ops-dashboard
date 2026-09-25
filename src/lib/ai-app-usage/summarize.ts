import { canonicalModelId } from "@/lib/ai-app-usage/models"
import type { AiAppPeriod, AiAppUsageApp, AiAppUsageTotals } from "@/types/ai-app-usage"

/**
 * アプリ別・モデル別の合計を出す純粋関数（#325）。画面（クライアント）から読むため、
 * サーバー専用の処理を import しないこと。
 */

export interface SummedTotals {
    calls: number
    /** 入力トークンを数えている行が1つも無ければ null */
    inputTokens: number | null
    /** 入力トークンを数えていない行が混じっている（合計は実際より少ない） */
    inputIncomplete: boolean
    /** 出力トークンを数えている行が1つも無ければ null */
    outputTokens: number | null
    /** 金額を計算できた行の合計。1行も計算できなければ null */
    costUsd: number | null
    /** 単価が分からず金額を計算できなかった行が混じっている（合計は実際より少ない）。トークン未集計の行は含めない */
    costIncomplete: boolean
}

export function sumTotals(list: AiAppUsageTotals[]): SummedTotals {
    const sum: SummedTotals = { calls: 0, inputTokens: null, inputIncomplete: false, outputTokens: null, costUsd: null, costIncomplete: false }

    for (const totals of list) {
        sum.calls += totals.calls
        if (totals.inputTokens === null) sum.inputIncomplete = true
        else sum.inputTokens = (sum.inputTokens ?? 0) + totals.inputTokens
        if (totals.outputTokens !== null) sum.outputTokens = (sum.outputTokens ?? 0) + totals.outputTokens
        // 入力トークンを数えていない行の金額が無いのは単価不明ではないため、costIncomplete にしない（inputIncomplete で示す）
        if (totals.costUsd === null) {
            if (totals.inputTokens !== null) sum.costIncomplete = true
        } else sum.costUsd = (sum.costUsd ?? 0) + totals.costUsd
    }

    return sum
}

export interface ModelCalls {
    /** {@link canonicalModelId} を通したモデルID */
    model: string
    calls: number
}

export interface AppSummary {
    app: AiAppUsageApp
    totals: SummedTotals
    /** 呼出回数の多い順。期間内に呼び出しの無いモデルは含めない */
    models: ModelCalls[]
}

export interface ModelSummary {
    model: string
    calls: number
    /** このモデルを使ったアプリ名。呼出回数の多い順 */
    apps: string[]
}

/** モデルIDごとに呼出回数を足す。呼び出しの無い行は数えない */
function callsByModel(app: AiAppUsageApp, period: AiAppPeriod): ModelCalls[] {
    const map = new Map<string, number>()
    for (const feature of app.features) {
        const calls = feature[period].calls
        if (calls === 0) continue

        const model = canonicalModelId(feature.model)
        map.set(model, (map.get(model) ?? 0) + calls)
    }

    return [...map.entries()].map(([model, calls]) => ({ model, calls })).sort((a, b) => b.calls - a.calls)
}

/**
 * アプリごとの集計。取得できたアプリを呼出回数の多い順に、取得できなかったアプリを名前順で末尾に並べる。
 * 取得できなかったアプリの合計は 0 だが、実際に 0 だったわけではないため、呼び出し側は合計へ含めない。
 */
export function summarizeApps(apps: AiAppUsageApp[], period: AiAppPeriod): AppSummary[] {
    const summaries = apps.map((app) => ({
        app,
        totals: sumTotals(app.features.map((feature) => feature[period])),
        models: callsByModel(app, period),
    }))

    const ok = summaries
        .filter((summary) => summary.app.status === "ok")
        .sort((a, b) => b.totals.calls - a.totals.calls || a.app.app.localeCompare(b.app.app))
    const failed = summaries
        .filter((summary) => summary.app.status !== "ok")
        .sort((a, b) => a.app.app.localeCompare(b.app.app))

    return [...ok, ...failed]
}

/** モデルごとの集計（どのアプリが使っているかの逆引き）。取得できなかったアプリは含めない */
export function summarizeModels(apps: AiAppUsageApp[], period: AiAppPeriod): ModelSummary[] {
    const map = new Map<string, { calls: number; byApp: Map<string, number> }>()

    for (const app of apps) {
        if (app.status !== "ok") continue

        for (const { model, calls } of callsByModel(app, period)) {
            const entry = map.get(model) ?? { calls: 0, byApp: new Map<string, number>() }
            entry.calls += calls
            entry.byApp.set(app.app, calls)
            map.set(model, entry)
        }
    }

    return [...map.entries()]
        .map(([model, entry]) => ({
            model,
            calls: entry.calls,
            apps: [...entry.byApp.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
        }))
        .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
}
