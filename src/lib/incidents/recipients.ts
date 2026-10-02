import type { StoredSubscription } from "@/lib/push/web-push"

/**
 * ホスト・監視の通知を受け取ってよい購読か。
 * - 利用者が記録されていない古い購読は、次の登録し直しで紐づくまで送らない
 * - 端末ごとに通知をオフにした購読は送らない
 * - いまアクセスが許可されていない利用者（取り消し後など）の端末へは、監視情報を送らない
 */
export function isHostAlertRecipient(
    subscription: StoredSubscription,
    isAllowed: (email: string) => boolean
): boolean {
    if (!subscription.email) return false
    if (subscription.hostAlerts === false) return false
    return isAllowed(subscription.email)
}
