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
    /** キャッシュ読出の合計。数えている行が1つも無ければ null（#498） */
    cacheReadTokens: number | null
    /** キャッシュ書込の合計。数えている行が1つも無ければ null */
    cacheWriteTokens: number | null
    /** 入力トークンを数えているのにキャッシュの内訳が省略された行が混じっている（入力・金額はキャッシュ0として計算済み） */
    cacheIncomplete: boolean
    /** 金額を計算できた行の合計。1行も計算できなければ null */
    costUsd: number | null
    /** 単価が分からず金額を計算できなかった行が混じっている（合計は実際より少ない）。トークン未集計の行は含めない */
    costIncomplete: boolean
}

export function sumTotals(list: AiAppUsageTotals[]): SummedTotals {
    const sum: SummedTotals = { calls: 0, inputTokens: null, inputIncomplete: false, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheIncomplete: false, costUsd: null, costIncomplete: false }

    for (const totals of list) {
        sum.calls += totals.calls
        if (totals.inputTokens === null) sum.inputIncomplete = true
        else sum.inputTokens = (sum.inputTokens ?? 0) + totals.inputTokens
        if (totals.outputTokens !== null) sum.outputTokens = (sum.outputTokens ?? 0) + totals.outputTokens
        if (totals.inputTokens !== null) {
            const { cacheReadTokens: read, cacheWriteTokens: write } = totals
            if (read == null || write == null) sum.cacheIncomplete = true
            if (read != null) sum.cacheReadTokens = (sum.cacheReadTokens ?? 0) + read
            if (write != null) sum.cacheWriteTokens = (sum.cacheWriteTokens ?? 0) + write
        }
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

/** グラフで比べる指標 */
export type AppMetric = "cost" | "calls" | "tokens"

export interface MetricSegment {
    model: string
    /** 指標の値（金額はUSD、トークンは入力＋出力）。不明な行は含めない */
    value: number
}

export interface AppMetricValue {
    /** 知れている分の合計。1行も知れなければ null（0と区別する） */
    value: number | null
    /** 不明な行を除いた部分集計である */
    partial: boolean
    /** モデル別の寄与。値の大きい順。不明な分は含めない */
    segments: MetricSegment[]
    /** 単価不明・トークン未集計の分を含むモデル */
    unknownModels: string[]
}

/**
 * アプリ1つの指標をモデル別に出す（#498）。使用トークン = 入力（キャッシュ読出・書込を含む。連携先が
 * 合算して返す）＋ 出力で、キャッシュを別に足さない。不明（null）の行は0にせず、部分集計として示す。
 */
export function appMetric(app: AiAppUsageApp, period: AiAppPeriod, metric: AppMetric): AppMetricValue {
    const byModel = new Map<string, number>()
    const unknown = new Set<string>()
    let known = false
    let partial = false

    for (const feature of app.features) {
        const row = feature[period]
        if (row.calls === 0) continue

        const model = canonicalModelId(feature.model)
        let value: number | null
        if (metric === "calls") value = row.calls
        else if (metric === "cost") value = row.costUsd
        else if (row.inputTokens === null) value = null
        else {
            value = row.inputTokens + (row.outputTokens ?? 0)
            // 出力を数えていない行の合計は、出力ぶん少ない
            if (row.outputTokens === null) partial = true
        }

        if (value === null) {
            unknown.add(model)
            partial = true
            continue
        }
        known = true
        byModel.set(model, (byModel.get(model) ?? 0) + value)
    }

    const segments = [...byModel.entries()].map(([model, value]) => ({ model, value })).sort((a, b) => b.value - a.value)
    return {
        value: known ? segments.reduce((sum, segment) => sum + segment.value, 0) : null,
        partial,
        segments,
        unknownModels: [...unknown],
    }
}

/** 指標の値が大きい順（不明は末尾。同値は呼出回数→名前）。取得できなかったアプリは常に最後 */
export function sortAppsByMetric(summaries: AppSummary[], period: AiAppPeriod, metric: AppMetric): AppSummary[] {
    const rows = summaries.map((summary) => ({ summary, value: summary.app.status === "ok" ? appMetric(summary.app, period, metric).value : null }))
    const ok = rows.filter((row) => row.summary.app.status === "ok")
    const failed = rows.filter((row) => row.summary.app.status !== "ok")
    ok.sort(
        (a, b) =>
            (b.value ?? -1) - (a.value ?? -1) ||
            b.summary.totals.calls - a.summary.totals.calls ||
            a.summary.app.app.localeCompare(b.summary.app.app)
    )
    return [...ok, ...failed].map((row) => row.summary)
}
