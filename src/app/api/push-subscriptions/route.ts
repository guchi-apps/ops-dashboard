import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import {
    getVapidPublicKey,
    isPushSubscription,
    isWebPushConfigured,
    removeSubscriptions,
    saveSubscription,
    sendPushTo,
} from "@/lib/push/web-push"

/**
 * AI利用枠のプッシュ通知（#263）を受け取る端末の登録。
 *
 * 登録した端末へは、サーバーが使用状況を取るたびに判定した通知が届く（`src/lib/ai-usage/alerts.ts`）。
 * 書き込みを伴うため、ログインセッションでだけ受け付ける（`OPS_API_TOKEN` では通さない）。
 */

/** 通知ボタンを出すかと、購読に使う公開鍵。鍵が未設定なら publicKey は null */
export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    return NextResponse.json({ publicKey: isWebPushConfigured() ? getVapidPublicKey() : null })
}

/**
 * `{ subscription, confirm }` — 端末を登録する。confirm が true なら確認の通知を1通送る
 * （ボタンで通知をオンにしたときだけ。起動のたびの登録し直しでは送らない）
 */
export async function POST(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    if (!isWebPushConfigured()) {
        return NextResponse.json({ error: "通知の鍵が設定されていません" }, { status: 503 })
    }

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { subscription, confirm } = (payload ?? {}) as Record<string, unknown>
    if (!isPushSubscription(subscription)) {
        return NextResponse.json({ error: "購読の形式が正しくありません" }, { status: 400 })
    }

    await saveSubscription(subscription)

    if (confirm === true) {
        const delivered = await sendPushTo(subscription, {
            title: "通知をオンにしました",
            body: "AI利用枠が上限に近づいたら、アプリを閉じていてもこの端末へ通知します。",
            tag: "push-confirm",
            url: "/?tab=usage",
        })
        return NextResponse.json({ ok: true, delivered }, { status: 201 })
    }

    return NextResponse.json({ ok: true }, { status: 201 })
}

/** `{ endpoint }` — この端末への通知を止める */
export async function DELETE(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { endpoint } = (payload ?? {}) as Record<string, unknown>
    if (typeof endpoint !== "string") {
        return NextResponse.json({ error: "endpoint を指定してください" }, { status: 400 })
    }

    await removeSubscriptions([endpoint])
    return NextResponse.json({ ok: true })
}
