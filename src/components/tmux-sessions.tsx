"use client"

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

/** フックのイベント名を、画面で意味の分かる言葉にする。知らない名前はそのまま出す */
const EVENT_LABELS: Record<string, string> = {
    Stop: "応答終了",
    permission_prompt: "入力待ち",
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

/**
 * issue-deck の自動回収が「このセッションを畳まない」と判断した理由（#59）。
 *
 * これが無いと、放置されているのか正当に待っているのかを一覧から区別できない。
 * 理由はホスト側の journald にしか出ず、しかも同じ理由が続く間は出力されない。
 */
function HoldNote({ session }: { session: TmuxSessionView }) {
    if (!session.holdReason) return null

    const notes = [
        // 「その理由になってから」であって「最後に判定してから」ではない
        session.holdForSeconds !== undefined ? `${formatAge(session.holdForSeconds)}から` : null,
        session.lastEventName
            ? [
                  EVENT_LABELS[session.lastEventName] ?? session.lastEventName,
                  session.sinceLastEventSeconds !== undefined
                      ? formatAge(session.sinceLastEventSeconds)
                      : null,
              ]
                  .filter(Boolean)
                  .join(" ")
            : null,
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
                                session.state === "running" && "bg-emerald-500/[0.07]",
                                session.state === "waiting" && "bg-sky-500/[0.07]",
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
                    </tr>
                </thead>
                <tbody>
                    {sessions.map((session) => (
                        <tr
                            key={sessionKey(session)}
                            className={cn(
                                "border-t border-border",
                                session.state === "running" && "bg-emerald-500/[0.06]",
                                session.state === "waiting" && "bg-sky-500/[0.06]"
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
                                <HoldNote session={session} />
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
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="flex flex-col gap-2 md:hidden">
                {sessions.map((session) => (
                    <div
                        key={sessionKey(session)}
                        className={cn(
                            "rounded-lg border border-border bg-muted/30 p-2.5",
                            session.state === "running" && "border-emerald-500/30 bg-emerald-500/[0.07]",
                            session.state === "waiting" && "border-sky-500/35 bg-sky-500/[0.07]",
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
                        <HoldNote session={session} />
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
