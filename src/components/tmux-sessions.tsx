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
                                session.state !== "running" && session.state !== "waiting" && "opacity-80"
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
                            <td className="whitespace-nowrap px-2 py-2 font-mono">{session.name}</td>
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
                                    // 入力待ちのセッションでは、この列がそのまま「待たせている時間」になる
                                    session.state === "waiting" && TEXT_TONES.info,
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
                            session.state === "waiting" && "border-sky-500/30 bg-sky-500/[0.07]",
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
                                    session.state === "waiting" && TEXT_TONES.info,
                                    session.state === "stale" && TEXT_TONES.warn
                                )}
                            >
                                {timeSummary(session)}
                            </span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[13px]">{session.name}</div>
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
                <span className="font-bold text-foreground">稼働中</span> ＝ コマンドが動いていて、画面も
                {WAITING_MINUTES}分以内に動いた
            </span>
            <span>
                <span className="font-bold text-foreground">入力待ち</span> ＝ コマンドは動いているが、画面が
                {WAITING_MINUTES}分以上 止まっている
            </span>
            <span>
                <span className="font-bold text-foreground">待機中</span> ＝ シェルだけで止まっている
            </span>
            <span>
                <span className="font-bold text-foreground">放置</span> ＝ デタッチのまま
                {STALE_HOURS}時間以上 活動がない
            </span>
        </div>
    )
}
