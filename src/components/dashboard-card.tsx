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
                "bg-primary text-primary-foreground border-none",
                "dark:bg-card dark:border dark:border-border dark:text-card-foreground",
                noPadding ? "p-0" : "p-6",
                className
            )}
            {...props}
        >
            {children}
        </div>
    )
}
