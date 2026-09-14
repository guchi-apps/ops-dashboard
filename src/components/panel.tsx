import { cn } from "@/lib/utils"

/** タブの中に並べるカードの外枠。見出しの高さを揃え、中身だけを差し替える */
export function Panel({
    title,
    trailing,
    className,
    children,
}: {
    title: string
    trailing?: React.ReactNode
    className?: string
    children: React.ReactNode
}) {
    return (
        <section className={cn("rounded-xl border border-border bg-card p-3", className)}>
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-bold">{title}</h2>
                {trailing}
            </div>
            {children}
        </section>
    )
}
