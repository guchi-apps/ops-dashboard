"use client"

import { useState } from "react"
import { useDashboardData } from "@/components/dashboard-data"
import { SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { SectionHeading } from "@/components/section-heading"
import { findModel, modelLabel, type ModelFamily } from "@/lib/ai-app-usage/models"
import { countStates, resolvePurposes, type AiPurposeRow, type AiPurposeState } from "@/lib/ai-app-usage/purposes"
import {
    sumTotals,
    summarizeApps,
    summarizeModels,
    type AppSummary,
    type ModelSummary,
    type SummedTotals,
} from "@/lib/ai-app-usage/summarize"
import { formatTokens, formatUsd } from "@/lib/usage-format"
import { cn } from "@/lib/utils"
import type { AiAppFeatureUsage, AiAppPeriod, AiAppUsageApp, AiAppUsageSnapshot } from "@/types/ai-app-usage"

const PERIODS: { id: AiAppPeriod; label: string; text: string }[] = [
    { id: "last24h", label: "24時間", text: "直近24時間" },
    { id: "last7d", label: "7日間", text: "直近7日間" },
]

/** モデルの系統ごとの色。一覧に無いモデルは無彩色にして、色だけで区別しない（名前も必ず出す） */
const FAMILY_DOT: Record<ModelFamily, string> = {
    opus: "bg-[#8ea2ee]",
    sonnet: "bg-[#4cc5b6]",
    haiku: "bg-[#e3bd58]",
    jev: "bg-[#ee8fb0]",
    gpt: "bg-[#f0a15c]",
}
const UNKNOWN_DOT = "bg-slate-400"

function dotClass(model: string): string {
    const info = findModel(model)
    return info ? FAMILY_DOT[info.family] : UNKNOWN_DOT
}

function ModelChip({ model }: { model: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-px pl-1.5 pr-2 text-[11px]">
            <span className={cn("size-2 shrink-0 rounded-[2px]", dotClass(model))} aria-hidden />
            {modelLabel(model)}
        </span>
    )
}

function PeriodToggle({ period, onChange }: { period: AiAppPeriod; onChange: (period: AiAppPeriod) => void }) {
    return (
        <div role="group" aria-label="集計期間" className="inline-flex rounded-lg border border-border bg-card p-0.5">
            {PERIODS.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    aria-pressed={period === item.id}
                    onClick={() => onChange(item.id)}
                    className={cn(
                        "rounded-md px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        period === item.id
                            ? "bg-primary font-semibold text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {item.label}
                </button>
            ))}
        </div>
    )
}

function Stat({ value, label, note }: { value: string; label: string; note?: string }) {
    return (
        <div className="min-w-0 bg-card px-3.5 py-2.5 sm:px-4 sm:py-3">
            <p className="truncate font-mono text-lg font-bold tabular-nums sm:text-[22px]">{value}</p>
            <p className="text-[10px] text-muted-foreground sm:text-[11px]">{label}</p>
            {note && <p className="text-[10px] text-amber-400">{note}</p>}
        </div>
    )
}

function costText(totals: SummedTotals): string {
    return totals.costUsd === null ? "—" : formatUsd(totals.costUsd)
}

function Summary({
    totals,
    modelCount,
    appCount,
    periodText,
}: {
    totals: SummedTotals
    modelCount: number
    appCount: number
    periodText: string
}) {
    return (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
            <Stat value={totals.calls.toLocaleString("ja-JP")} label={`呼出回数（${periodText}）`} />
            <Stat
                value={totals.inputTokens === null ? "—" : formatTokens(totals.inputTokens)}
                label="入力トークン"
                note={totals.inputIncomplete && totals.inputTokens !== null ? "トークン未集計のアプリを除く" : undefined}
            />
            <Stat
                value={totals.outputTokens === null ? "—" : formatTokens(totals.outputTokens)}
                label="出力トークン"
            />
            <Stat
                value={costText(totals)}
                label="概算金額"
                note={
                    totals.costUsd === null
                        ? undefined
                        : totals.costIncomplete
                          ? "単価不明のモデルを除く"
                          : totals.inputIncomplete
                            ? "トークン未集計のアプリを除く"
                            : undefined
                }
            />
            <Stat value={`${modelCount} 種`} label={`使用モデル · ${appCount} アプリ`} />
        </div>
    )
}

/** 呼出回数の割合。モデルごとに色分けした帯で、幅は最も呼出の多いアプリを基準にする */
function CallsMeter({ summary, maxCalls, totalCalls }: { summary: AppSummary; maxCalls: number; totalCalls: number }) {
    const { calls } = summary.totals
    const share = totalCalls > 0 ? Math.round((calls / totalCalls) * 100) : 0
    const width = maxCalls > 0 ? (calls / maxCalls) * 100 : 0

    return (
        <div>
            <div
                className="h-2.5 overflow-hidden rounded-[3px] bg-muted"
                role="img"
                aria-label={`呼出 ${calls.toLocaleString("ja-JP")} 回、全体の ${share}%（${summary.models
                    .map((entry) => `${modelLabel(entry.model)} ${entry.calls}回`)
                    .join("、")}）`}
            >
                <div className="flex h-full gap-px" style={{ width: `${width}%` }}>
                    {summary.models.map((entry) => (
                        <span
                            key={entry.model}
                            className={cn("h-full", dotClass(entry.model))}
                            style={{ width: `${(entry.calls / calls) * 100}%` }}
                        />
                    ))}
                </div>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">全体の {share}%</p>
        </div>
    )
}

function FeatureRows({ features, period }: { features: AiAppFeatureUsage[]; period: AiAppPeriod }) {
    const rows = features.filter((feature) => feature[period].calls > 0).sort((a, b) => b[period].calls - a[period].calls)
    if (rows.length === 0) {
        return <p className="py-1 text-xs text-muted-foreground">この期間は呼び出しがありません</p>
    }

    return (
        <ul className="divide-y divide-dashed divide-border">
            {rows.map((feature) => {
                const totals = feature[period]
                return (
                    <li key={`${feature.label}\n${feature.model}`} className="ai-app-feature py-1.5 text-xs">
                        <span data-area="feat" className="min-w-0 break-words">
                            {feature.label}
                        </span>
                        <span data-area="model">
                            <ModelChip model={feature.model} />
                        </span>
                        <span data-area="calls" className="hidden text-right font-mono tabular-nums md:block">
                            {totals.calls.toLocaleString("ja-JP")}
                        </span>
                        <span data-area="tok" className="font-mono tabular-nums md:text-right">
                            <span className="md:hidden">{totals.calls.toLocaleString("ja-JP")}回 · </span>
                            {totals.inputTokens === null ? "—" : formatTokens(totals.inputTokens)} /{" "}
                            {totals.outputTokens === null ? "—" : formatTokens(totals.outputTokens)}
                        </span>
                        <span
                            data-area="cost"
                            className="text-right font-mono tabular-nums max-md:font-semibold"
                        >
                            {totals.costUsd === null ? "—" : formatUsd(totals.costUsd)}
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}

function AppItem({
    summary,
    period,
    maxCalls,
    totalCalls,
    open,
    onToggle,
}: {
    summary: AppSummary
    period: AiAppPeriod
    maxCalls: number
    totalCalls: number
    open: boolean
    onToggle: () => void
}) {
    const { app, totals, models } = summary

    if (app.status !== "ok") {
        return (
            <li className="border-t border-border first:border-t-0">
                <div className="ai-app-row px-3.5 py-3 sm:px-4">
                    <span data-area="name" className="flex min-w-0 items-center gap-2">
                        <span className="w-2.5 shrink-0" aria-hidden />
                        <b className="truncate text-sm font-semibold">{app.app}</b>
                        <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-px text-[10px] font-semibold text-amber-400">
                            取得不可
                        </span>
                    </span>
                    <span data-area="note" className="text-xs text-muted-foreground">
                        {app.message ?? "取得できませんでした"}。次の更新で取り直します
                    </span>
                </div>
            </li>
        )
    }

    return (
        <li className="border-t border-border first:border-t-0">
            <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className="ai-app-row w-full px-3.5 py-3 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4"
            >
                <span data-area="name" className="flex min-w-0 items-center gap-2">
                    <span className="w-2.5 shrink-0 text-[10px] text-muted-foreground" aria-hidden>
                        {open ? "▼" : "▶"}
                    </span>
                    <b className="truncate text-sm font-semibold">{app.app}</b>
                </span>
                <span data-area="models" className="flex flex-wrap gap-1">
                    {models.length > 0 ? (
                        models.map((entry) => <ModelChip key={entry.model} model={entry.model} />)
                    ) : (
                        <span className="text-[11px] text-muted-foreground">呼び出しなし</span>
                    )}
                </span>
                <span data-area="bar">
                    <CallsMeter summary={summary} maxCalls={maxCalls} totalCalls={totalCalls} />
                </span>
                <span data-area="calls" className="font-mono text-xs tabular-nums md:text-right md:text-[13px]">
                    <span className="mr-1.5 font-sans text-[11px] text-muted-foreground md:hidden">呼出</span>
                    {totals.calls.toLocaleString("ja-JP")}
                </span>
                <span
                    data-area="tok"
                    className="text-right font-mono text-xs tabular-nums md:text-[13px]"
                >
                    <span className="mr-1.5 font-sans text-[11px] text-muted-foreground md:hidden">入力/出力</span>
                    {totals.inputTokens === null ? "—" : formatTokens(totals.inputTokens)}
                    <span className="text-[10px] text-muted-foreground md:block">
                        {" / "}
                        {totals.outputTokens === null ? "—" : formatTokens(totals.outputTokens)}
                    </span>
                </span>
                <span
                    data-area="cost"
                    className="self-start text-right font-mono text-base font-bold tabular-nums md:self-center md:text-[13px] md:font-medium"
                    title={totals.costIncomplete ? "単価が分からないモデルを除いた金額です" : undefined}
                >
                    {costText(totals)}
                    {totals.costIncomplete && totals.costUsd !== null && <span aria-hidden>+</span>}
                </span>
            </button>
            {open && (
                <div className="border-t border-border bg-muted/50 px-3.5 py-2 sm:px-4 md:pl-9">
                    <FeatureRows features={app.features} period={period} />
                </div>
            )}
        </li>
    )
}

function ModelPanel({ models }: { models: ModelSummary[] }) {
    const max = models[0]?.calls ?? 0

    return (
        <aside className="grid gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                使用中のモデル
            </h3>
            {models.length === 0 && <p className="text-xs text-muted-foreground">この期間の呼び出しはありません</p>}
            {models.map((entry) => {
                const info = findModel(entry.model)

                return (
                    <div key={entry.model} className="grid gap-1">
                        <div className="flex items-center gap-2">
                            <span className={cn("size-2 shrink-0 rounded-[2px]", dotClass(entry.model))} aria-hidden />
                            <b className="min-w-0 truncate text-[13px] font-semibold">{modelLabel(entry.model)}</b>
                            {info && <span className="text-[11px] text-muted-foreground">{info.provider}</span>}
                            <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                                {entry.calls.toLocaleString("ja-JP")} 回
                            </span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-[3px] bg-muted">
                            <div
                                className={cn("h-full", dotClass(entry.model))}
                                style={{ width: `${max > 0 ? (entry.calls / max) * 100 : 0}%` }}
                            />
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            使用アプリ: <span className="font-medium text-foreground">{entry.apps.join("・")}</span>
                        </p>
                        {info && info.label !== entry.model && (
                            <p className="font-mono text-[10px] text-muted-foreground">{entry.model}</p>
                        )}
                    </div>
                )
            })}
        </aside>
    )
}

const PURPOSE_STATE: Record<AiPurposeState, { text: string; className: string; hint: string }> = {
    measured: { text: "計測中", className: "bg-status-ok/15 text-status-ok", hint: "上の一覧に表示" },
    failed: { text: "取得不可", className: "bg-destructive/15 text-destructive", hint: "連携先から取得できていない" },
    unlinked: { text: "未連携", className: "bg-amber-500/15 text-amber-400", hint: "使用量APIを読めていない" },
    quota: { text: "枠のみ", className: "bg-muted text-muted-foreground", hint: "利用枠のカードで確認" },
}

function PurposeItem({ row }: { row: AiPurposeRow }) {
    const state = PURPOSE_STATE[row.state]
    return (
        <li className="ai-purpose-row border-t border-border px-4 py-2.5 text-xs first:border-t-0">
            <span data-area="name" className="truncate text-sm font-medium">
                {row.app}
            </span>
            <span data-area="label" className="text-muted-foreground">
                {row.label}
            </span>
            <span data-area="prov" className="text-muted-foreground">
                {row.provider}
                <span className="block text-[11px]">{state.hint}</span>
            </span>
            <span
                data-area="state"
                className={cn("whitespace-nowrap rounded-full px-2 py-px text-[11px]", state.className)}
            >
                {state.text}
            </span>
        </li>
    )
}

/** AIを使っている用途の一覧。使用量を読めていないものを見つけるための区画 */
function PurposeList({ apps }: { apps: AiAppUsageApp[] }) {
    const rows = resolvePurposes(apps)
    const counts = countStates(rows)
    const groups: { title: string; rows: AiPurposeRow[] }[] = [
        { title: "アプリが呼ぶAI（API課金）", rows: rows.filter((row) => row.kind === "metered") },
        { title: "サブスクの枠を使うAI（アプリ別には数えられない）", rows: rows.filter((row) => row.kind === "quota") },
    ]

    return (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h3 className="text-sm font-medium">AIの用途一覧</h3>
                <p className="flex flex-wrap gap-1.5 text-[11px]">
                    {(["measured", "failed", "unlinked", "quota"] as const)
                        .filter((key) => counts[key] > 0)
                        .map((key) => (
                            <span key={key} className={cn("rounded-full px-2 py-px", PURPOSE_STATE[key].className)}>
                                {PURPOSE_STATE[key].text} {counts[key]}
                            </span>
                        ))}
                </p>
            </div>
            {groups.map((group) => (
                <div key={group.title}>
                    <p className="bg-muted px-4 py-1.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        {group.title}
                    </p>
                    <ul>
                        {group.rows.map((row) => (
                            <PurposeItem key={row.app} row={row} />
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    )
}

function okApps(apps: AiAppUsageApp[]): AiAppUsageApp[] {
    return apps.filter((app) => app.status === "ok")
}

/**
 * アプリごとのAI利用。どのアプリが、どのモデルで、どれだけ使っているかを見る。
 * 連携先が1つも無ければ何も出さない（TypeSafeカードと同じく、未設定の系統は数えない）。
 */
export function AiAppUsage() {
    const { aiAppUsage: snapshot } = useDashboardData()

    if (snapshot) return <AiAppUsageView snapshot={snapshot} />

    // 取得前は骨組みを出す。連携先が無い環境では、取得後にこのセクションごと消える
    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading title="アプリ別のAI利用" />
            <SkeletonGroup
                label="アプリ別のAI利用"
                className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4"
            >
                <SkeletonBar />
                <SkeletonBar />
                <SkeletonBar />
            </SkeletonGroup>
        </section>
    )
}

/** 取得済みのスナップショットを描く部分。取得（`useDashboardData`）から切り離してあり、画面確認で作り物の値を渡せる */
export function AiAppUsageView({ snapshot }: { snapshot: AiAppUsageSnapshot }) {
    const [period, setPeriod] = useState<AiAppPeriod>("last24h")
    // 行を開閉した結果だけを持つ。触っていない行は、呼出回数が最も多いアプリだけ開いておく
    const [toggled, setToggled] = useState<Record<string, boolean>>({})

    if (snapshot.apps.length === 0) return null

    const periodText = PERIODS.find((item) => item.id === period)?.text ?? ""
    const summaries = summarizeApps(snapshot.apps, period)
    const models = summarizeModels(snapshot.apps, period)
    const ok = okApps(snapshot.apps)
    const totals = sumTotals(ok.flatMap((app) => app.features.map((feature) => feature[period])))
    const maxCalls = Math.max(0, ...summaries.map((summary) => summary.totals.calls))
    const failedCount = snapshot.apps.length - ok.length

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="アプリ別のAI利用"
                trailing={
                    <>
                        <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                            {new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", {
                                hour: "2-digit",
                                minute: "2-digit",
                            })}{" "}
                            時点
                        </span>
                        <PeriodToggle period={period} onChange={setPeriod} />
                    </>
                }
            />

            <Summary totals={totals} modelCount={models.length} appCount={ok.length} periodText={periodText} />
            {failedCount > 0 && (
                <p className="-mt-1 text-[11px] text-muted-foreground">
                    取得できなかった {failedCount} アプリは合計に含めていません。
                </p>
            )}

            <div className="grid items-start gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <div
                        className="ai-app-row ai-app-head hidden border-b border-border bg-muted px-4 py-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground md:grid"
                        aria-hidden
                    >
                        <span data-area="name">
                            アプリ<span className="xl:hidden">・使用モデル</span>
                        </span>
                        <span data-area="models" className="hidden xl:block">
                            使用モデル
                        </span>
                        <span data-area="bar">呼出回数（モデル別）</span>
                        <span data-area="calls" className="text-right">
                            呼出
                        </span>
                        <span data-area="tok" className="text-right">
                            入力 / 出力
                        </span>
                        <span data-area="cost" className="text-right">
                            概算
                        </span>
                    </div>
                    <ul>
                        {summaries.map((summary, index) => (
                            <AppItem
                                key={summary.app.app}
                                summary={summary}
                                period={period}
                                maxCalls={maxCalls}
                                totalCalls={totals.calls}
                                open={toggled[summary.app.app] ?? index === 0}
                                onToggle={() =>
                                    setToggled((current) => ({
                                        ...current,
                                        [summary.app.app]: !(current[summary.app.app] ?? index === 0),
                                    }))
                                }
                            />
                        ))}
                    </ul>
                </div>

                <ModelPanel models={models} />
            </div>

            <PurposeList apps={snapshot.apps} />

            <p className="text-[11px] text-muted-foreground">
                概算金額は、各アプリが数えたトークン数と単価表からの推計で、請求額そのものではありません。
                GPT-5.6系（Codex経由）はChatGPTの定額枠で動くため請求は発生せず、公開API単価での換算の目安です。
                行を押すと機能ごとの内訳を開閉します。
            </p>
        </section>
    )
}
