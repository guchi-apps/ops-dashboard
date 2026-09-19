"use client"

import { LogOut, Menu } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"

/** メニュー内の1行。通知の行（usage-notifications.tsx）とログアウトで見た目をそろえる */
export const MENU_ITEM_CLASS =
    "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * ヘッダー右上のメニュー（#268）。通知の設定とログアウトを収める。
 *
 * 通知ボタンを足したことで、狭い画面ではヘッダーの右端が収まらなくなったため、
 * 更新時刻と更新ボタンだけをヘッダーに残し、それ以外はここへまとめる。
 *
 * **閉じている間もパネルはDOMに残し、`hidden` で隠している。** 通知の行（`children`）は
 * マウント時にService Workerの登録と購読の登録し直しを行うため、開いたときにだけ
 * 描画すると、メニューを一度も開かない端末では通知の準備が走らなくなる。
 */
export function HeaderMenu({
    userEmail,
    children,
}: {
    userEmail: string
    /** ログインの表示とログアウトの間に置く行（通知の設定） */
    children?: React.ReactNode
}) {
    const [open, setOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const panelId = useId()

    // 外側を押すか Esc で閉じる。Esc で閉じたときはボタンへフォーカスを戻す
    useEffect(() => {
        if (!open) return

        const onPointerDown = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            setOpen(false)
            buttonRef.current?.focus()
        }
        document.addEventListener("pointerdown", onPointerDown)
        document.addEventListener("keydown", onKeyDown)
        return () => {
            document.removeEventListener("pointerdown", onPointerDown)
            document.removeEventListener("keydown", onKeyDown)
        }
    }, [open])

    return (
        <div ref={containerRef} className="relative">
            <Button
                ref={buttonRef}
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-label="メニュー"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={panelId}
                title="メニュー"
                className="px-2 sm:px-3"
            >
                <Menu className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">メニュー</span>
            </Button>

            <div
                id={panelId}
                role="dialog"
                aria-label="メニュー"
                hidden={!open}
                className="absolute right-0 top-full z-50 mt-2 w-72 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
                {userEmail && (
                    <div className="px-2.5 pb-2 pt-1.5">
                        <div className="text-[10px] tracking-[0.1em] text-muted-foreground">ログイン中</div>
                        <div className="truncate text-xs">{userEmail}</div>
                    </div>
                )}

                {children}

                <div className="mt-1 border-t border-border pt-1">
                    <form action="/auth/signout" method="POST">
                        <button type="submit" className={MENU_ITEM_CLASS}>
                            <LogOut className="size-3.5 text-muted-foreground" aria-hidden />
                            ログアウト
                        </button>
                    </form>
                </div>
            </div>
        </div>
    )
}
