import { Lock } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 読み込めていないものの場所と形を残す灰色の骨組み。
 * 動きを減らす設定の端末では明滅させず、静止した骨組みのままにする。
 */
export function Skeleton({ className }: { className?: string }) {
    return (
        <div
            aria-hidden
            className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
        />
    )
}

/** UsageBar 1本ぶんの骨組み（ラベルと値の行＋バー） */
export function SkeletonBar() {
    return (
        <div className="space-y-1.5">
            <div className="flex justify-between gap-2">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-1/5" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
        </div>
    )
}

/**
 * 骨組みを並べる枠。スクリーンリーダーには中身が読み込み中であることだけを伝える。
 * 見た目は `SkeletonBar` などを子に置く
 */
export function SkeletonGroup({
    label,
    className,
    children,
}: {
    label: string
    className?: string
    children: React.ReactNode
}) {
    return (
        <div role="status" aria-busy="true" aria-label={`${label}を読み込んでいます`} className={className}>
            {children}
        </div>
    )
}

/**
 * 権限不足（401・403・スコープ不足）で取得できないときの表示。
 * 取得の失敗（赤）でも読み込み中（灰色の骨組み）でもなく、こちらで直さない限り出ないことを伝える。
 */
export function AccessDenied({
    reason,
    compact = false,
}: {
    /** 表示できない理由。サーバーが組み立てた短い文（トークンやURLは含まれない） */
    reason?: string
    compact?: boolean
}) {
    return (
        <div
            role="status"
            className={cn(
                "flex gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300",
                compact ? "p-2 text-[10px]" : "p-2.5 text-xs sm:p-3"
            )}
        >
            <Lock className={cn("mt-0.5 shrink-0", compact ? "size-3" : "size-4")} aria-hidden />
            <div className="min-w-0 space-y-0.5">
                <p className={cn("font-bold", compact ? "text-[11px]" : "text-[13px]")}>
                    表示できません（権限不足）
                </p>
                {reason && <p className="break-words opacity-90">{reason}</p>}
            </div>
        </div>
    )
}
