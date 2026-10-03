import { headers } from "next/headers"

import { getAccessDb } from "@/lib/access/db"
import { recordLoginEvent } from "@/lib/access/policy"
import { getStatusHubAccess } from "@/lib/access/status-hub"
import { clientIpFromForwardedFor } from "@/lib/client-ip"
import { sendPushWhere } from "@/lib/push/web-push"

/**
 * Googleログイン成功を、アクセス管理の履歴へ残し、管理者の端末へWeb Pushで知らせる（#516。Signalyの代わり）。
 *
 * **ログインを止めない。** 記録・送信の失敗はログに残すだけで例外を投げない。送信はプッシュサービスの
 * 応答を待たない（`void`）ため、ログインの完了はその遅さに引きずられない。
 *
 * 接続元IPは `X-Forwarded-For` の末尾から読む（`clientIpFromForwardedFor`。先頭はクライアントが決められる）。
 * 送り先は、いまアクセスが許可されている管理者の、端末ごとの設定（`loginAlerts`）がオフでない購読だけ。
 * 「新しい接続元のみ」の端末へは、初めて見る接続元IPのときだけ送る。
 */
export async function recordAndNotifyLogin(options: { email: string }): Promise<void> {
    try {
        const headersList = await headers()
        const event = recordLoginEvent(
            getAccessDb(),
            {
                email: options.email,
                ip: clientIpFromForwardedFor(headersList.get("x-forwarded-for")),
                userAgent: headersList.get("user-agent")?.slice(0, 500) ?? null,
            },
            new Date()
        )

        const detail = [
            event.newIp ? "新しい接続元" : null,
            event.ip,
            event.userAgent?.slice(0, 120),
        ].filter(Boolean)

        void sendPushWhere(
            (subscription) => {
                if (!subscription.email || !getStatusHubAccess(subscription.email).isAdmin) return false
                const mode = subscription.loginAlerts ?? "always"
                return mode === "always" || (mode === "new" && event.newIp)
            },
            {
                title: `🔐 ログイン: ${event.email}`,
                body: detail.join(" ・ "),
                tag: `login-${event.id}`,
                url: "/admin/access",
            }
        ).catch((error) => console.error("[login-notify] 通知の送信に失敗しました:", error))
    } catch (error) {
        console.error("[login-notify] ログインの記録に失敗しました:", error)
    }
}
