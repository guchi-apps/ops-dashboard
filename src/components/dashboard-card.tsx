import { cn } from "@/lib/utils"

interface DashboardCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode
    noPadding?: boolean
    /**
     * surface — 背景になじむ面（既定）。項目を並べる一覧で使う
     * primary — 濃いネイビーの面。単独で強調したいカードで使う
     *
     * 一覧を高密度に並べる画面では、濃い面が並ぶと状態色（緑・赤・橙）が沈むため surface を既定にしている。
     */
    tone?: "surface" | "primary"
}

const TONES = {
    surface: "bg-card text-card-foreground border border-border",
    primary: "bg-primary text-primary-foreground border-none dark:bg-card dark:border dark:border-border dark:text-card-foreground",
} as const

export function DashboardCard({
    children,
    className,
    noPadding = false,
    tone = "surface",
    ...props
}: DashboardCardProps) {
    return (
        <div
            className={cn(
                "rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md relative group",
                TONES[tone],
                noPadding ? "p-0" : "p-6",
                className
            )}
            {...props}
        >
            {children}
        </div>
    )
}
