import { getStatusHubAccess } from "@/lib/access/status-hub"
import { isHostAlertRecipient } from "@/lib/incidents/recipients"
import { isWebPushConfigured, sendPushWhere, type PushMessage } from "@/lib/push/web-push"

/**
 * 単価の更新候補・チェック失敗の通知先（#497）。
 *
 * **`sendPushToAll` は使わない。** アクセス許可を取り消した利用者の端末にも届いてしまう（#489）。
 * ホスト障害通知（#495）と同じく、いまアクセスが許可されている利用者の端末だけへ送る。
 * 端末ごとの「ホスト・監視の障害通知」のオフも引き継ぐ（運用上の通知を1つの切り替えにまとめるため）。
 * 1台以上へ届いたときだけ true を返し、届かなければ次の実行で送り直す。
 */
export async function sendPriceWatchPush(message: PushMessage): Promise<boolean> {
    if (!isWebPushConfigured()) return false
    const result = await sendPushWhere(
        (subscription) => isHostAlertRecipient(subscription, (email) => getStatusHubAccess(email).allowed),
        message
    )
    return result.delivered > 0
}
