"use client"

import { Link as LinkIcon } from "lucide-react"
import { DashboardCard } from "@/components/dashboard-card"
import { cn } from "@/lib/utils"

function BoldLinkLabel({ label, className }: { label: string; className?: string }) {
    return (
        <div className={cn("flex items-center gap-1.5 min-w-0 max-w-full", className)}>
            <span className="font-bold truncate">{label}</span>
            <LinkIcon className="h-4 w-4 shrink-0" aria-hidden />
        </div>
    )
}

function MonitorCardLink({
    href,
    label,
    children,
}: {
    href?: string
    label: string
    children: React.ReactNode
}) {
    if (!href) return <>{children}</>

    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}（外部リンク）`}
            className="block h-full w-full rounded-xl transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
        >
            {children}
        </a>
    )
}

export function MonitorCard({
    label,
    statusText,
    statusColor,
    uptimeLabel,
    href,
}: {
    label: string
    statusText: string
    statusColor: string
    uptimeLabel?: string
    href?: string
}) {
    return (
        <MonitorCardLink href={href} label={label}>
            <DashboardCard
                className={cn(
                    "h-full flex flex-col justify-center items-center text-center gap-1",
                    href && "cursor-pointer"
                )}
            >
                {href ? (
                    <BoldLinkLabel label={label} className="text-sm px-2" />
                ) : (
                    <span
                        className="text-xs opacity-70 uppercase tracking-widest truncate w-full px-2"
                        title={label}
                    >
                        {label}
                    </span>
                )}
                <div className={`text-2xl font-bold font-mono ${statusColor}`}>{statusText}</div>
                {uptimeLabel && (
                    <div className="text-sm font-medium text-blue-100 dark:text-slate-400">
                        {uptimeLabel}
                    </div>
                )}
            </DashboardCard>
        </MonitorCardLink>
    )
}

export function MonitorCardGrid({ children, count }: { children: React.ReactNode; count: number }) {
    const gridCols =
        count === 1
            ? "grid-cols-1"
            : count === 2
              ? "md:grid-cols-2"
              : count === 3
                ? "md:grid-cols-3"
                : "md:grid-cols-2 lg:grid-cols-4"

    return <div className={`grid grid-cols-1 ${gridCols} gap-4 h-full`}>{children}</div>
}
