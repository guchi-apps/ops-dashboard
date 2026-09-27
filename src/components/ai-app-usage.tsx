"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { SectionHeading } from "@/components/section-heading"
import { Button } from "@/components/ui/button"
import { findModel, modelLabel, type ModelFamily } from "@/lib/ai-app-usage/models"
import { countStates, resolvePurposes, type AiPurposeRow, type AiPurposeState } from "@/lib/ai-app-usage/purposes"
import type { AiAppUsageSource } from "@/lib/ai-app-usage/sources"
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

type SourceDraft = AiAppUsageSource
type SourceScreen = { kind: "list" } | { kind: "edit"; index: number | null }

function emptySource(): SourceDraft {
    return { app: "", url: "" }
}

/**
 * 連携先は画面を開く人だけでなく、issue-deckなどのエージェントも設定APIから更新する。
 * タブ切り替えの transform に固定配置が閉じ込められないよう、モーダルは body へ出す。
 */
function AiAppUsageSourcesModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<boolean> }) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const [sources, setSources] = useState<SourceDraft[]>([])
    const [screen, setScreen] = useState<SourceScreen>({ kind: "list" })
    const [draft, setDraft] = useState<SourceDraft>(emptySource)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const controller = new AbortController()
        const load = async () => {
            try {
                const response = await fetch("/api/ai-app-usage/sources", { signal: controller.signal })
                const result = (await response.json()) as { sources?: unknown; error?: unknown }
                if (!response.ok || !Array.isArray(result.sources)) {
                    throw new Error(typeof result.error === "string" ? result.error : "連携先を読み込めません")
                }
                setSources(result.sources.map((source) => {
                    const value = source as Partial<AiAppUsageSource>
                    return { app: value.app ?? "", url: value.url ?? "" }
                }))
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "連携先を読み込めません")
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        }
        void load()

        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)
        return () => {
            controller.abort()
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            previouslyFocused?.focus()
        }
    }, [onClose])

    const saveSources = async (nextSources: SourceDraft[]): Promise<boolean> => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch("/api/ai-app-usage/sources", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sources: nextSources }),
            })
            const result = (await response.json()) as { sources?: unknown; error?: unknown }
            if (!response.ok || !Array.isArray(result.sources)) {
                throw new Error(typeof result.error === "string" ? result.error : "連携先を保存できません")
            }
            setSources(result.sources.map((source) => {
                const value = source as Partial<AiAppUsageSource>
                return { app: value.app ?? "", url: value.url ?? "" }
            }))
            if (!(await onSaved())) setError("設定は保存しましたが、使用量を取得できませんでした。")
            return true
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "連携先を保存できません")
            return false
        } finally {
            setSaving(false)
        }
    }

    const openNew = () => {
        setDraft(emptySource())
        setError(null)
        setScreen({ kind: "edit", index: null })
    }

    const openEdit = (index: number) => {
        setDraft(sources[index])
        setError(null)
        setScreen({ kind: "edit", index })
    }

    const saveDraft = async () => {
        if (screen.kind !== "edit") return
        const nextSources = screen.index === null
            ? [...sources, draft]
            : sources.map((source, index) => (index === screen.index ? draft : source))
        if (await saveSources(nextSources)) setScreen({ kind: "list" })
    }

    const removeDraft = async () => {
        if (screen.kind !== "edit" || screen.index === null) return
        if (await saveSources(sources.filter((_, index) => index !== screen.index))) setScreen({ kind: "list" })
    }

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label="AI利用の連携先を管理" onClick={(event) => event.stopPropagation()} className="flex max-h-[86dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:max-h-[min(82dvh,720px)] sm:rounded-2xl">
                <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 pb-3 pt-3.5">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-bold">{screen.kind === "list" ? "連携先を管理" : screen.index === null ? "連携先を追加" : "連携先を編集"}</h2>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">保存すると、すぐに最新の使用量を取得して画面へ反映します。</p>
                    </div>
                    <button ref={closeRef} type="button" onClick={onClose} aria-label="閉じる" className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><X aria-hidden /></button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    {loading ? <SkeletonGroup label="連携先を読み込み中" className="space-y-2"><SkeletonBar /><SkeletonBar /></SkeletonGroup> : screen.kind === "list" ? <>
                        <Button type="button" size="sm" onClick={openNew}><Plus aria-hidden />新規追加</Button>
                        {sources.length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">連携先はまだありません。</p> : (
                            <ul className="overflow-hidden rounded-lg border border-border bg-card">
                                {sources.map((source, index) => (
                                    <li key={`${source.app}-${index}`} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{source.app}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{source.url}</p></div>
                                        <Button type="button" variant="outline" size="sm" onClick={() => openEdit(index)}><Pencil aria-hidden />編集</Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </> : <>
                        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setScreen({ kind: "list" })} disabled={saving}><ArrowLeft aria-hidden />一覧へ戻る</Button>
                        <label className="grid gap-1 text-xs font-medium">アプリ名<input value={draft.app} onChange={(event) => setDraft((current) => ({ ...current, app: event.target.value }))} placeholder="issue-deck" className="h-9 rounded-md border border-input bg-background px-2 text-sm font-normal" disabled={saving} /></label>
                        <label className="grid gap-1 text-xs font-medium">使用量API URL<input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/api/ai-usage" inputMode="url" className="h-9 rounded-md border border-input bg-background px-2 text-sm font-normal" disabled={saving} /></label>
                        {screen.index !== null && <div className="flex justify-end border-t border-border pt-3"><Button type="button" variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => void removeDraft()} disabled={saving} aria-label={`${draft.app || "この"}連携先を削除`}><Trash2 aria-hidden /></Button></div>}
                    </>}
                    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
                    <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>{screen.kind === "list" ? "閉じる" : "キャンセル"}</Button>
                    {screen.kind === "edit" && <Button type="button" size="sm" onClick={() => void saveDraft()} disabled={loading || saving}>{saving ? "保存・取得中…" : "保存"}</Button>}
                </div>
            </div>
        </div>,
        document.body
    )
}

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

/** アプリごとのAI利用。どのアプリが、どのモデルで、どれだけ使っているかを見る。 */
export function AiAppUsage() {
    const { aiAppUsage: snapshot, refreshAiAppUsage } = useDashboardData()
    const [settingsOpen, setSettingsOpen] = useState(false)
    const onSaved = () => refreshAiAppUsage()

    if (snapshot) {
        return (
            <>
                <AiAppUsageView snapshot={snapshot} onManageSources={() => setSettingsOpen(true)} />
                {settingsOpen && <AiAppUsageSourcesModal onClose={() => setSettingsOpen(false)} onSaved={onSaved} />}
            </>
        )
    }

    // 取得前も管理画面を開けるよう、骨組みと設定ボタンは残す。
    return (
        <>
            <section className="space-y-3 sm:space-y-4">
                <SectionHeading
                    title="アプリ別のAI利用"
                    trailing={<Button type="button" variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>連携先を管理</Button>}
                />
                <SkeletonGroup
                    label="アプリ別のAI利用"
                    className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4"
                >
                    <SkeletonBar />
                    <SkeletonBar />
                    <SkeletonBar />
                </SkeletonGroup>
            </section>
            {settingsOpen && <AiAppUsageSourcesModal onClose={() => setSettingsOpen(false)} onSaved={onSaved} />}
        </>
    )
}

/** 取得済みのスナップショットを描く部分。取得（`useDashboardData`）から切り離してあり、画面確認で作り物の値を渡せる */
export function AiAppUsageView({
    snapshot,
    onManageSources,
}: {
    snapshot: AiAppUsageSnapshot
    onManageSources?: () => void
}) {
    const [period, setPeriod] = useState<AiAppPeriod>("last24h")
    // 行を開閉した結果だけを持つ。触っていない行は、呼出回数が最も多いアプリだけ開いておく
    const [toggled, setToggled] = useState<Record<string, boolean>>({})

    if (snapshot.apps.length === 0) {
        return (
            <section className="space-y-3 sm:space-y-4">
                <SectionHeading
                    title="アプリ別のAI利用"
                    trailing={onManageSources && <Button type="button" variant="outline" size="sm" onClick={onManageSources}>連携先を管理</Button>}
                />
                <p className="rounded-xl border border-border bg-card px-4 py-5 text-center text-xs text-muted-foreground">
                    連携先を追加すると、アプリ別のAI利用をここに表示します。
                </p>
            </section>
        )
    }

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
                        {onManageSources && <Button type="button" variant="outline" size="sm" onClick={onManageSources}>連携先を管理</Button>}
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
