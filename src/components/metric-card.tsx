import { DashboardCard } from "@/components/dashboard-card"
import { cn } from "@/lib/utils"

/** 使用率の色分け。VPS Status とサブPC Status で同じ基準を使う */
export function getUsageColor(percent: number): string {
    if (percent >= 90) return "text-red-400"
    if (percent >= 75) return "text-amber-400"
    return "text-emerald-400"
}

interface MetricCardProps {
    label: string
    value: string
    detail?: string
    valueClassName?: string
    /** モックデータであることを示す枠線を付ける */
    isMock?: boolean
    /** 値の下に敷く推移グラフなど */
    chart?: React.ReactNode
    /** 値を薄く表示する（サブPCがオフラインで、表示値が過去のものになっている場合） */
    dimmed?: boolean
}

export function MetricCard({
    label,
    value,
    detail,
    valueClassName,
    isMock,
    chart,
    dimmed,
}: MetricCardProps) {
    return (
        <DashboardCard
            className={cn(
                "h-full flex flex-col justify-center items-center text-center px-3 py-4 sm:px-4 sm:py-5",
                isMock && "ring-1 ring-dashed ring-amber-500/40",
                dimmed && "opacity-60"
            )}
        >
            <span className="text-[10px] sm:text-xs opacity-70 uppercase tracking-widest mb-1.5 sm:mb-2">
                {label}
            </span>
            <div className={cn("text-xl sm:text-2xl font-bold font-mono break-all", valueClassName)}>
                {value}
            </div>
            {detail && (
                <div className="text-xs sm:text-sm font-medium text-primary-foreground/70 dark:text-muted-foreground mt-1.5 sm:mt-2 break-words">
                    {detail}
                </div>
            )}
            {chart && <div className="w-full mt-2 sm:mt-3">{chart}</div>}
        </DashboardCard>
    )
}
