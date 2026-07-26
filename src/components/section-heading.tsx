import { cn } from "@/lib/utils"

interface SectionHeadingProps {
    title: string
    trailing?: React.ReactNode
    className?: string
}

export function SectionHeading({ title, trailing, className }: SectionHeadingProps) {
    return (
        <div className={cn("flex items-center gap-4", className)}>
            <div className="h-8 w-1 shrink-0 bg-blue-600 rounded-full" />
            <h2 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
                {title}
            </h2>
            {trailing && <div className="flex items-center gap-2 ml-auto min-w-0">{trailing}</div>}
        </div>
    )
}
