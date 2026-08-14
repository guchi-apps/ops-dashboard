import { cn } from "@/lib/utils"

/** 状態の4段階。ホスト・監視・tmux・使用量で同じ色の意味を保つためにここへ集約する */
export type StatusTone = "ok" | "warn" | "danger" | "neutral"

export const BADGE_TONES: Record<StatusTone, string> = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    neutral: "border-border bg-muted/50 text-muted-foreground",
}

export const DOT_TONES: Record<StatusTone, string> = {
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    danger: "bg-red-500",
    neutral: "bg-muted-foreground",
}

export const TEXT_TONES: Record<StatusTone, string> = {
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
}

export const BORDER_TONES: Record<StatusTone, string> = {
    ok: "border-l-emerald-500",
    warn: "border-l-amber-500",
    danger: "border-l-red-500",
    neutral: "border-l-muted-foreground/40",
}

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
    return <span className={cn("size-1.5 shrink-0 rounded-full", DOT_TONES[tone], className)} aria-hidden />
}

export function StatusBadge({
    tone,
    children,
    withDot,
    className,
}: {
    tone: StatusTone
    children: React.ReactNode
    withDot?: boolean
    className?: string
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] sm:text-xs font-mono",
                BADGE_TONES[tone],
                className
            )}
        >
            {withDot && <StatusDot tone={tone} />}
            {children}
        </span>
    )
}
