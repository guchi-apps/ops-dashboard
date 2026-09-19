"use client"

import { Bell, BellOff, ChevronDown } from "lucide-react"
import { useCallback, useEffect, useId, useState } from "react"
import { MENU_ITEM_CLASS } from "@/components/header-menu"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * ヘッダーメニュー内の「通知」の行（#263・#268）。AI利用枠が上限に近づいたときのプッシュ通知を、この端末で受け取るかを切り替える。
 *
 * 行を押すとその場で設定が開く。判定と送信はサーバー側（`src/lib/ai-usage/alerts.ts`）で、ここがするのは端末の登録だけ。
 * 通知の許可はボタン操作の中でしか求められない（特にiOS）ため、「通知をオンにする」を押したときに許可を求める。
 * サーバーに鍵が無ければ行ごと出さない。
 *
 * メニューを閉じている間もマウントされたままなので、下の初期化はメニューを開かなくても走る。
 */

/**
 * unsupported — このブラウザでは受け取れない（iPhoneのSafariのタブなど）
 * default     — まだ許可を求めていない
 * granted     — この端末へ届く
 * denied      — 以前「許可しない」を選んだ
 */
type NotifyState = "unsupported" | "default" | "granted" | "denied"

/** 行の右に出す、この端末の状態 */
const STATE_LABELS: Record<NotifyState, string> = {
    granted: "オン",
    default: "オフ",
    denied: "ブロック中",
    unsupported: "非対応",
}

const SERVICE_WORKER_PATH = "/sw.js"

function isPushSupported(): boolean {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

/** iPhone・iPadのSafari。ホーム画面に追加したアプリからでないと通知を受け取れない */
function isIosBrowserTab(): boolean {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    return ios && !standalone
}

/** VAPIDの公開鍵（base64url）を購読に渡す形へ */
function toApplicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4)
    const binary = window.atob((base64Url + padding).replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
}

async function postSubscription(subscription: PushSubscription, confirm: boolean): Promise<boolean> {
    const res = await fetch("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), confirm }),
    })
    return res.ok
}

async function subscribe(publicKey: string): Promise<PushSubscription> {
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    if (existing) return existing

    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toApplicationServerKey(publicKey),
    })
}

export function UsageNotifications() {
    const [publicKey, setPublicKey] = useState<string | null>(null)
    const [state, setState] = useState<NotifyState>("default")
    const [iosTab, setIosTab] = useState(false)
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const detailId = useId()

    // 鍵の有無を確かめ、Service Workerを登録する。すでに許可済みの端末は、サーバー側の記録が
    // 消えていても届くよう、起動のたびに購読を登録し直す（確認の通知は送らない）
    useEffect(() => {
        let cancelled = false

        const init = async () => {
            const res = await fetch("/api/push-subscriptions", { cache: "no-store" }).catch(() => null)
            const key = res?.ok ? ((await res.json()) as { publicKey: string | null }).publicKey : null
            if (cancelled || !key) return

            if (!isPushSupported()) {
                setIosTab(isIosBrowserTab())
                setState("unsupported")
                setPublicKey(key)
                return
            }

            await navigator.serviceWorker.register(SERVICE_WORKER_PATH)
            const permission = Notification.permission
            if (permission === "granted") {
                const subscription = await subscribe(key)
                await postSubscription(subscription, false)
            }
            if (cancelled) return

            setState(permission)
            setPublicKey(key)
        }

        init().catch((reason) => console.error("通知の準備に失敗しました:", reason))
        return () => {
            cancelled = true
        }
    }, [])

    const enable = useCallback(async () => {
        if (!publicKey) return
        setBusy(true)
        setError(null)
        try {
            const permission = await Notification.requestPermission()
            setState(permission)
            if (permission !== "granted") return

            const subscription = await subscribe(publicKey)
            if (!(await postSubscription(subscription, true))) {
                setError("サーバーへの登録に失敗しました。時間をおいてもう一度押してください。")
                return
            }
            setOpen(false)
        } catch (reason) {
            console.error("通知をオンにできませんでした:", reason)
            setError("通知をオンにできませんでした。時間をおいてもう一度押してください。")
        } finally {
            setBusy(false)
        }
    }, [publicKey])

    const disable = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (subscription) {
                await fetch("/api/push-subscriptions", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ endpoint: subscription.endpoint }),
                })
                await subscription.unsubscribe()
            }
            // 許可そのものはページから取り消せないため、次に押したときは確認なしで登録し直す
            setState("default")
            setOpen(false)
        } catch (reason) {
            console.error("通知をオフにできませんでした:", reason)
            setError("通知をオフにできませんでした。")
        } finally {
            setBusy(false)
        }
    }, [])

    if (!publicKey) return null

    const enabled = state === "granted"
    const Icon = enabled ? Bell : BellOff
    const stateLabel = STATE_LABELS[state]

    return (
        <div className="mt-1 border-t border-border pt-1">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={detailId}
                className={MENU_ITEM_CLASS}
            >
                <Icon
                    className={cn("size-3.5", enabled ? "text-primary" : "text-muted-foreground")}
                    aria-hidden
                />
                <span className="flex-1">通知</span>
                <span
                    className={cn(
                        "rounded-full px-2 py-px text-[11px] font-bold",
                        enabled ? "bg-primary/10 text-primary" : "font-normal text-muted-foreground"
                    )}
                >
                    {stateLabel}
                </span>
                <ChevronDown
                    className={cn("size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")}
                    aria-hidden
                />
            </button>

            {open && (
                <div id={detailId} className="mx-1 mb-1 mt-0.5 space-y-2 rounded-md bg-muted p-3 text-xs">
                    {state === "granted" && (
                        <>
                            <p className="font-bold">通知は有効です</p>
                            <NotifyConditions />
                            <p className="text-muted-foreground">アプリを閉じていても届きます。</p>
                            <div className="flex justify-end">
                                <Button variant="outline" size="sm" type="button" onClick={disable} disabled={busy}>
                                    この端末への通知を止める
                                </Button>
                            </div>
                        </>
                    )}
                    {state === "default" && (
                        <>
                            <p className="font-bold">通知をオンにしますか？</p>
                            <NotifyConditions />
                            <p className="text-muted-foreground">
                                アプリを閉じていてもこの端末へ通知します。次に出る確認で「許可」を選んでください。
                            </p>
                            <div className="flex justify-end">
                                <Button size="sm" type="button" onClick={enable} disabled={busy}>
                                    {busy ? "設定中…" : "通知をオンにする"}
                                </Button>
                            </div>
                        </>
                    )}
                    {state === "denied" && (
                        <>
                            <p className="font-bold">通知がブロックされています</p>
                            <p className="text-muted-foreground">
                                以前「許可しない」を選んだため、ここからは許可を求められません。端末（またはブラウザ）の設定で、このサイトの通知を許可してから開き直してください。
                            </p>
                        </>
                    )}
                    {state === "unsupported" && (
                        <>
                            <p className="font-bold">この開き方では通知を受け取れません</p>
                            <p className="text-muted-foreground">
                                {iosTab
                                    ? "iPhone・iPadでは、共有メニューの「ホーム画面に追加」から追加したアプリで開くと使えます。"
                                    : "このブラウザはプッシュ通知に対応していません。"}
                            </p>
                        </>
                    )}
                    {error && <p className="text-destructive">{error}</p>}
                </div>
            )}
        </div>
    )
}

function NotifyConditions() {
    return (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>Claude 5時間枠が90%以上</li>
            <li>週間枠（Claude・ChatGPT）が95%以上</li>
            <li>上記の枠が100%に到達</li>
        </ul>
    )
}
