"use client"

import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Pencil } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { Button } from "@/components/ui/button"
import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { MAX_DISPLAY_NAME_LENGTH, type MonitorSource } from "@/lib/monitor-source"
import { cn } from "@/lib/utils"

/**
 * 監視カードの表示名を変えるボタンとダイアログ（#479）。
 *
 * カードは外部リンクの `<a>` で包まれることがあり、タブ切り替えの transform の中では `fixed` が
 * 画面基準にならないため、ダイアログは body 直下へ portal で出す（job-history-modal.tsx と同じ）。
 * PCは中央のダイアログ、スマホは下から出るシート。
 */
export function MonitorNameEditor({
    source,
    id,
    name,
    originalName,
    className,
}: {
    source: MonitorSource
    id: number
    /** いま画面に出ている名前 */
    name: string
    /** 変更済みのときの提供元の名前 */
    originalName?: string
    className?: string
}) {
    const [open, setOpen] = useState(false)

    return (
        <>
            <button
                type="button"
                onClick={(event) => {
                    // 外部リンクのカードの中でも、リンクを開かずに編集だけ開く
                    event.preventDefault()
                    event.stopPropagation()
                    setOpen(true)
                }}
                aria-label={`${name}の表示名を変更`}
                title="表示名を変更"
                className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary",
                    className
                )}
            >
                <Pencil className="size-3.5" aria-hidden />
            </button>
            {open && (
                <NameDialog
                    source={source}
                    id={id}
                    name={name}
                    originalName={originalName}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    )
}

function NameDialog({
    source,
    id,
    name,
    originalName,
    onClose,
}: {
    source: MonitorSource
    id: number
    name: string
    originalName?: string
    onClose: () => void
}) {
    const { refreshMonitors } = useDashboardData()
    const inputId = useId()
    const inputRef = useRef<HTMLInputElement>(null)
    const [value, setValue] = useState(name)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        inputRef.current?.select()

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKeyDown)

        return () => {
            window.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            previouslyFocused?.focus()
        }
    }, [onClose])

    const send = async (method: "PUT" | "DELETE", nextName: string) => {
        if (sending) return
        setSending(true)
        setError(null)

        try {
            const res =
                method === "PUT"
                    ? await fetch("/api/monitor-names", {
                          method,
                          headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
                          body: JSON.stringify({ source, id, name: nextName }),
                      })
                    : await fetch(`/api/monitor-names?source=${source}&id=${id}`, {
                          method,
                          headers: CSRF_HEADERS,
                      })

            if (!res.ok) {
                const payload = (await res.json().catch(() => null)) as { error?: string } | null
                setError(payload?.error ?? `保存に失敗しました（${res.status}）`)
                setSending(false)
                return
            }

            await refreshMonitors()
            onClose()
        } catch {
            setError("保存に失敗しました。通信を確認してください。")
            setSending(false)
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5"
            onClick={onClose}
        >
            <form
                role="dialog"
                aria-modal="true"
                aria-label="表示名を変更"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                    event.preventDefault()
                    void send("PUT", value)
                }}
                className="flex w-full max-w-[440px] flex-col gap-3 rounded-t-2xl border border-border bg-popover p-4 pb-7 text-popover-foreground shadow-2xl sm:rounded-2xl sm:pb-4"
            >
                <h3 className="text-sm font-bold">表示名を変更</h3>
                {originalName && (
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        元の名前: {originalName}
                    </p>
                )}
                <div className="space-y-1.5">
                    <label htmlFor={inputId} className="block text-xs text-muted-foreground">
                        表示名
                    </label>
                    {/* iOSは16px未満の入力欄にフォーカスすると画面を自動拡大するため、スマホ幅は16px（#483） */}
                    <input
                        id={inputId}
                        ref={inputRef}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        maxLength={MAX_DISPLAY_NAME_LENGTH}
                        disabled={sending}
                        className="h-9 w-full rounded-md border bg-background px-3 text-base outline-none sm:text-sm transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"
                    />
                    <p className="text-[11px] text-muted-foreground">
                        このダッシュボードの表示だけが変わります。空にして保存すると元の名前に戻ります。
                    </p>
                </div>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <div className="flex gap-2">
                    {originalName && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={sending}
                            onClick={() => void send("DELETE", "")}
                            className="flex-1 sm:flex-none"
                        >
                            元に戻す
                        </Button>
                    )}
                    <span className="hidden flex-1 sm:block" />
                    <Button type="button" variant="outline" size="sm" onClick={onClose} className="hidden sm:inline-flex">
                        キャンセル
                    </Button>
                    <Button type="submit" size="sm" disabled={sending} className="flex-1 sm:flex-none">
                        {sending ? "保存中…" : "保存"}
                    </Button>
                </div>
            </form>
        </div>,
        document.body
    )
}
