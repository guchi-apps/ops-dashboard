import { cn } from "@/lib/utils"

interface DashboardCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode
    noPadding?: boolean
}

export function DashboardCard({ children, className, noPadding = false, ...props }: DashboardCardProps) {
    return (
        <div
            className={cn(
                "rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md relative group",
                "bg-blue-600 text-white border-none",
                "dark:bg-slate-900 dark:border dark:border-slate-700 dark:text-slate-100",
                noPadding ? "p-0" : "p-6",
                className
            )}
            {...props}
        >
            {children}
        </div>
    )
}
