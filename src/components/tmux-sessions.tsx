"use client"

import { Fragment, useEffect, useState } from "react"
import { StatusDot, TEXT_TONES, type StatusTone } from "@/components/status-badge"
import { formatAge, formatUptime } from "@/lib/host-stats/format"
import {
    TMUX_STALE_AFTER_SECONDS,
    TMUX_STATE_LABELS,
    TMUX_WAITING_AFTER_SECONDS,
    type TmuxSessionState,
    type TmuxSessionView,
} from "@/lib/host-stats/tmux"
import { cn } from "@/lib/utils"

const STATE_TONES: Record<TmuxSessionState, StatusTone> = {
    running: "ok",
    // 入力待ちは異常ではなく「こちらが動けば進む」状態なので、放置（warn）とは別の色にする
    waiting: "info",
    idle: "neutral",
    stale: "warn",
}

const STALE_HOURS = Math.round(TMUX_STALE_AFTER_SECONDS / 3600)
const WAITING_MINUTES = Math.round(TMUX_WAITING_AFTER_SECONDS / 60)

/** 実行中コマンドのタグ。シェルしか無いセッションでは何も出さない */
function CommandTags({ session }: { session: TmuxSessionView }) {
    if (!session.commands?.length) {
        // busy を送ってこない世代のエージェントでは、コマンド名まで分からない
        return session.busy === undefined ? null : (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                shell
            </span>
        )
    }

    return (
        <>
            {session.commands.map((command) => (
                <span
                    key={command}
                    className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] text-foreground"
                >
                    {command}
                </span>
            ))}
        </>
    )
}

function sessionKey(session: TmuxSessionView): string {
    return `${session.hostId}/${session.user ?? ""}/${session.name}`
}

/** 依頼してからこの時間が過ぎても一覧に残っていれば、閉じられなかったものとして扱う（サーバーの期限と同じ） */
const CLOSE_TIMEOUT_MS = 180_000

type CloseState =
    | { kind: "idle" }
    | { kind: "confirming" }
    | { kind: "sending" }
    | { kind: "pending" }
    | { kind: "failed"; message: string }

interface CloseRequestEntry {
    at: number
    error?: string
}

/**
 * 閉じる操作の状態。押す → 確認 → 依頼 → 一覧から消えたら完了。
 *
 * 実際に閉じるのはホストのエージェントで、依頼は次の受信で渡る（最大1分ほど）。
 * 完了の通知は無いので、一覧から消えたことで判断する。
 * 依頼の記録には作成時刻を含めており、同じ名前のセッションが立て直されても古い依頼を引き継がない。
 */
function useTmuxClose() {
    const [confirmKey, setConfirmKey] = useState<string | null>(null)
    const [requests, setRequests] = useState<Record<string, CloseRequestEntry>>({})
    const [now, setNow] = useState(() => Date.now())

    const waiting = Object.values(requests).some((entry) => !entry.error)
    useEffect(() => {
        if (!waiting) return
        const timer = setInterval(() => setNow(Date.now()), 5_000)
        return () => clearInterval(timer)
    }, [waiting])

    const keyOf = (session: TmuxSessionView) => `${sessionKey(session)}@${session.createdAt ?? ""}`

    function stateOf(session: TmuxSessionView): CloseState {
        const key = keyOf(session)
        const entry = requests[key]

        if (entry?.error) return { kind: "failed", message: entry.error }
        if (entry === undefined) return { kind: confirmKey === key ? "confirming" : "idle" }
        if (entry.at === 0) return { kind: "sending" }
        if (now - entry.at > CLOSE_TIMEOUT_MS) {
            return { kind: "failed", message: "閉じられませんでした。ホストのエージェントが止まっている可能性があります" }
        }
        return confirmKey === key ? { kind: "confirming" } : { kind: "pending" }
    }

    async function confirm(session: TmuxSessionView) {
        const key = keyOf(session)
        setConfirmKey(null)
        setRequests((current) => ({ ...current, [key]: { at: 0 } }))

        try {
            const response = await fetch("/api/tmux-close", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    hostId: session.hostId,
                    user: session.user,
                    name: session.name,
                }),
            })
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { error?: string } | null
                throw new Error(body?.error ?? `HTTP ${response.status}`)
            }
            setNow(Date.now())
            setRequests((current) => ({ ...current, [key]: { at: Date.now() } }))
        } catch (error) {
            const message = error instanceof Error ? error.message : "依頼を送れませんでした"
            setRequests((current) => ({ ...current, [key]: { at: 0, error: message } }))
        }
    }

    return {
        stateOf,
        ask: (session: TmuxSessionView) => {
            // 失敗の表示から「もう一度」を押したときは、前回の記録を捨てて確認からやり直す
            setRequests((current) => {
                const rest = { ...current }
                delete rest[keyOf(session)]
                return rest
            })
            setConfirmKey(keyOf(session))
        },
        cancel: () => setConfirmKey(null),
        confirm,
    }
}

type TmuxClose = ReturnType<typeof useTmuxClose>

/** 閉じられるのは、持ち主（user）が分かるセッションだけ。古い世代のエージェントは送ってこない */
function canClose(session: TmuxSessionView): boolean {
    return session.user !== undefined
}

/** 行の操作。押すと確認が開く。依頼中は状態だけを出す */
function CloseAction({ session, close }: { session: TmuxSessionView; close: TmuxClose }) {
    if (!canClose(session)) return <span className="text-muted-foreground">-</span>

    const state = close.stateOf(session)

    if (state.kind === "sending" || state.kind === "pending") {
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                    aria-hidden
                    className="inline-block size-2.5 animate-spin rounded-full border-2 border-muted-foreground border-r-transparent motion-reduce:animate-none"
                />
                閉じています…
            </span>
        )
    }

    return (
        <button
            type="button"
            onClick={() => close.ask(session)}
            aria-expanded={state.kind === "confirming"}
            aria-label={`${session.name} を閉じる`}
            className={cn(
                "rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-red-400 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400",
                state.kind === "confirming" && "border-red-400 text-red-400"
            )}
        >
            {state.kind === "failed" ? "もう一度" : "閉じる"}
        </button>
    )
}

/** 確認の行。何が失われるかを示してから確定する。失敗したときは理由もここに出す */
function CloseConfirm({ session, close }: { session: TmuxSessionView; close: TmuxClose }) {
    const state = close.stateOf(session)

    if (state.kind === "failed") {
        return (
            <p role="alert" className={cn("text-[11px]", TEXT_TONES.danger)}>
                {state.message}
            </p>
        )
    }
    if (state.kind !== "confirming") return null

    const running = session.commands?.length ? session.commands.join("・") : null

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-red-400/40 bg-red-400/[0.08] px-3 py-2.5">
            <p className="min-w-[14rem] flex-1 whitespace-normal text-[11.5px] leading-snug">
                <span className="font-mono font-bold">{session.name}</span> を閉じますか？
                {running && (
                    <>
                        {" "}
                        実行中の <span className="font-mono font-bold">{running}</span> も終了し、作業中の内容は失われます。
                    </>
                )}
                <span className="block text-[10.5px] text-muted-foreground">
                    ホスト: {session.hostLabel}　閉じたセッションは元に戻せません。反映まで最大1分ほどかかります。
                </span>
            </p>
            <div className="flex w-full gap-2 sm:w-auto">
                <button
                    type="button"
                    onClick={close.cancel}
                    className="flex-1 rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted sm:flex-none"
                >
                    やめる
                </button>
                <button
                    type="button"
                    onClick={() => void close.confirm(session)}
                    className="flex-1 rounded-md bg-red-400 px-3 py-1.5 text-[11px] font-bold text-red-950 hover:bg-red-300 sm:flex-none"
                >
                    閉じる
                </button>
            </div>
        </div>
    )
}

/** フックのイベント名を、画面で意味の分かる言葉にする。知らない名前はそのまま出す */
const EVENT_LABELS: Record<string, string> = {
    Stop: "応答終了",
    permission_prompt: "承認・質問で待機",
    // 「人が答えて作業へ戻った」を表す。入力待ちではない（#72）
    working: "作業再開",
}

/** Issue が分かるセッションは、名前からその Issue へ飛べるようにする */
function SessionName({ session }: { session: TmuxSessionView }) {
    if (!session.issueRepository || session.issueNumber === undefined) {
        return <span className="font-mono">{session.name}</span>
    }

    return (
        <a
            href={`https://github.com/${session.issueRepository}/issues/${session.issueNumber}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
            {session.name}
        </a>
    )
}

/** フックが最後に記録したイベントを「言葉 + 経過」の1つの句にする */
function eventNote(session: TmuxSessionView): string | null {
    if (!session.lastEventName) return null

    return [
        EVENT_LABELS[session.lastEventName] ?? session.lastEventName,
        session.sinceLastEventSeconds !== undefined
            ? formatAge(session.sinceLastEventSeconds)
            : null,
    ]
        .filter(Boolean)
        .join(" ")
}

/**
 * その状態と判断した根拠。次の2つを、あるものだけ出す。
 *
 * - 残す理由: issue-deck の自動回収が「このセッションを畳まない」と判断した理由（#59）。
 *   これが無いと、放置されているのか正当に待っているのかを一覧から区別できない。
 *   理由はホスト側の journald にしか出ず、しかも同じ理由が続く間は出力されない
 * - 最後のイベント: フックの記録。**入力待ちかどうかの第一の根拠がこれ**なので、
 *   回収の判定に乗らないセッション（残す理由が付かないもの）でも出す（#72）
 */
function SessionNote({ session }: { session: TmuxSessionView }) {
    const event = eventNote(session)

    if (!session.holdReason) {
        if (event === null) return null

        return (
            <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                <span className="opacity-70">最後のイベント: </span>
                {event}
            </div>
        )
    }

    const notes = [
        // 「その理由になってから」であって「最後に判定してから」ではない
        session.holdForSeconds !== undefined ? `${formatAge(session.holdForSeconds)}から` : null,
        event,
    ].filter((note): note is string => note !== null)

    return (
        <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            <span className="opacity-70">残す理由: </span>
            {session.holdReason}
            {notes.length > 0 && <span className="opacity-70">（{notes.join(" · ")}）</span>}
        </div>
    )
}

/** セッションの経過と最終活動。作成時刻を読めないホストでは出せる分だけ出す */
function timeSummary(session: TmuxSessionView): string {
    const parts = [
        session.ageSeconds !== undefined ? formatUptime(session.ageSeconds) : null,
        session.inactiveSeconds !== undefined ? formatAge(session.inactiveSeconds) : null,
    ].filter((part): part is string => part !== null)

    return parts.join(" · ")
}

/**
 * 概要タブに出す一覧。稼働中を上に寄せ、何が動いていて何が止まっているかだけを見せる。
 * 作業ディレクトリや窓数まで見たいときは tmux タブへ。
 */
export function TmuxSessionList({
    sessions,
    withHostLabel,
}: {
    sessions: TmuxSessionView[]
    withHostLabel: boolean
}) {
    if (sessions.length === 0) {
        return <p className="text-xs text-muted-foreground">起動中のセッションはありません</p>
    }

    return (
        <div className="flex flex-col gap-0.5">
            {sessions.map((session, index) => {
                const previous = sessions[index - 1]
                const showGroup = previous?.state !== session.state

                return (
                    <div key={sessionKey(session)}>
                        {showGroup && (
                            <div className="mb-1 mt-2 flex items-center gap-2 first:mt-0">
                                <span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                                    {TMUX_STATE_LABELS[session.state]}
                                </span>
                                <span className="h-px flex-1 bg-border" />
                            </div>
                        )}
                        <div
                            className={cn(
                                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]",
                                session.state === "running" && "bg-status-ok/[0.07]",
                                session.state === "waiting" && "bg-highlight/[0.07]",
                                // 入力待ちは薄くしない。こちらが動けば進むもので、埋もれさせたくない
                                session.state !== "running" &&
                                    session.state !== "waiting" &&
                                    "opacity-80"
                            )}
                        >
                            <StatusDot tone={STATE_TONES[session.state]} />
                            <span className="min-w-0 flex-1 truncate font-mono" title={session.name}>
                                {session.name}
                            </span>
                            {withHostLabel && (
                                <span className="shrink-0 text-[9px] text-muted-foreground">
                                    {session.hostLabel}
                                </span>
                            )}
                            <span className="flex shrink-0 gap-1">
                                <CommandTags session={session} />
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 text-right font-mono text-[10px] text-muted-foreground",
                                    session.state === "stale" && TEXT_TONES.warn
                                )}
                            >
                                {session.ageSeconds !== undefined ? formatUptime(session.ageSeconds) : "-"}
                            </span>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

/** tmux タブの一覧。広い画面では表、狭い画面ではカードに切り替える */
export function TmuxSessionTable({ sessions }: { sessions: TmuxSessionView[] }) {
    const close = useTmuxClose()

    if (sessions.length === 0) {
        return <p className="text-sm text-muted-foreground">tmux のセッションはありません</p>
    }

    return (
        <>
            <table className="hidden w-full border-collapse text-xs md:table">
                <thead>
                    <tr className="text-left text-[9px] uppercase tracking-[0.13em] text-muted-foreground">
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">状態</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">セッション</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">実行中</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">作業ディレクトリ</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">ホスト</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">窓</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">アタッチ</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">経過</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">最終活動</th>
                        <th className="whitespace-nowrap px-2 pb-2 font-semibold">操作</th>
                    </tr>
                </thead>
                <tbody>
                    {sessions.map((session) => (
                        <Fragment key={sessionKey(session)}>
                        <tr
                            className={cn(
                                "border-t border-border",
                                session.state === "running" && "bg-status-ok/[0.06]",
                                session.state === "waiting" && "bg-highlight/[0.06]"
                            )}
                        >
                            <td className="whitespace-nowrap px-2 py-2">
                                <span className="inline-flex items-center gap-1.5">
                                    <StatusDot tone={STATE_TONES[session.state]} />
                                    <span className={TEXT_TONES[STATE_TONES[session.state]]}>
                                        {TMUX_STATE_LABELS[session.state]}
                                    </span>
                                </span>
                            </td>
                            <td className="max-w-[24rem] px-2 py-2 align-top">
                                <SessionName session={session} />
                                <SessionNote session={session} />
                            </td>
                            <td className="whitespace-nowrap px-2 py-2">
                                <span className="flex gap-1">
                                    <CommandTags session={session} />
                                </span>
                            </td>
                            <td className="max-w-[16rem] truncate px-2 py-2 font-mono text-muted-foreground">
                                {session.path ?? "-"}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                                {session.hostLabel}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 font-mono">{session.windows}</td>
                            <td className="whitespace-nowrap px-2 py-2 font-mono">
                                {session.attached ? (
                                    <span className={TEXT_TONES.ok}>アタッチ中</span>
                                ) : (
                                    <span className="text-muted-foreground">デタッチ</span>
                                )}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">
                                {session.ageSeconds !== undefined ? formatUptime(session.ageSeconds) : "-"}
                            </td>
                            <td
                                className={cn(
                                    "whitespace-nowrap px-2 py-2 font-mono text-muted-foreground",
                                    session.state === "stale" && TEXT_TONES.warn
                                )}
                            >
                                {session.inactiveSeconds !== undefined
                                    ? formatAge(session.inactiveSeconds)
                                    : "-"}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2">
                                <CloseAction session={session} close={close} />
                            </td>
                        </tr>
                        {close.stateOf(session).kind === "confirming" ||
                        close.stateOf(session).kind === "failed" ? (
                            <tr>
                                <td colSpan={10} className="px-2 pb-2.5">
                                    <CloseConfirm session={session} close={close} />
                                </td>
                            </tr>
                        ) : null}
                        </Fragment>
                    ))}
                </tbody>
            </table>

            <div className="flex flex-col gap-2 md:hidden">
                {sessions.map((session) => (
                    <div
                        key={sessionKey(session)}
                        className={cn(
                            "rounded-lg border border-border bg-muted/30 p-2.5",
                            session.state === "running" && "border-status-ok/30 bg-status-ok/[0.07]",
                            session.state === "waiting" && "border-highlight/35 bg-highlight/[0.07]",
                            session.state === "stale" && "border-amber-500/35 bg-amber-500/[0.07]"
                        )}
                    >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                            <StatusDot tone={STATE_TONES[session.state]} />
                            <span className={cn("font-bold", TEXT_TONES[STATE_TONES[session.state]])}>
                                {TMUX_STATE_LABELS[session.state]}
                            </span>
                            <span className="flex gap-1">
                                <CommandTags session={session} />
                            </span>
                            <span
                                className={cn(
                                    "ml-auto font-mono text-[10px] text-muted-foreground",
                                    session.state === "stale" && TEXT_TONES.warn
                                )}
                            >
                                {timeSummary(session)}
                            </span>
                        </div>
                        <div className="mt-1 truncate text-[13px]">
                            <SessionName session={session} />
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                            {[
                                session.path,
                                session.hostLabel,
                                `${session.windows}窓`,
                                session.attached ? "アタッチ中" : "デタッチ",
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        </div>
                        <SessionNote session={session} />
                        <div className="mt-2 flex flex-col gap-2">
                            <div className="flex justify-end">
                                <CloseAction session={session} close={close} />
                            </div>
                            <CloseConfirm session={session} close={close} />
                        </div>
                    </div>
                ))}
            </div>
        </>
    )
}

/** 状態の決め方を画面上でも示す。判断の根拠が分からないと一覧を信用できないため */
export function TmuxLegend() {
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            <span>
                <span className="font-bold text-foreground">稼働中</span>{" "}
                ＝ シェル以外のコマンドがペインで動いていて、画面も動いている
            </span>
            <span>
                <span className="font-bold text-foreground">入力待ち</span>{" "}
                ＝ 承認や質問で人を待っている（またはコマンドは動いているが画面が
                {WAITING_MINUTES}分以上 止まっている）
            </span>
            <span>
                <span className="font-bold text-foreground">待機中</span> ＝ シェルだけで止まっている
            </span>
            <span>
                <span className="font-bold text-foreground">放置</span> ＝ デタッチのまま
                {STALE_HOURS}時間以上 活動がない
            </span>
            <span>
                <span className="font-bold text-foreground">残す理由</span> ＝ issue-deck
                の自動回収が、そのセッションを畳まずに残している理由
            </span>
        </div>
    )
}
