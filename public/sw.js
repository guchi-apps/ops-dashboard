// AI利用枠のプッシュ通知（#263）を受けるService Worker。
// 画面を閉じていても通知を出せるのはここだけなので、処理は通知の表示とタップ時の遷移に絞っている
// （キャッシュやオフライン対応は持たない）。
//
// src/proxy.ts の matcher から外してある。登録時のスクリプト取得がログイン画面へリダイレクトされると、
// ブラウザは登録そのものを失敗させるため。

self.addEventListener("install", () => {
    self.skipWaiting()
})

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim())
})

// 未解消エラー件数のバッジ（#495）。Service Worker はPush 1件ごとに止められ、変数を持てないため、
// 反映した通番（seq）をIndexedDBへ残し、遅れて届いた古いPushで件数を巻き戻さない。
// ページ側（src/lib/incidents/badge-client.ts）も同じDB・ストア・キーを読み書きする。
const BADGE_DB = "status-hub-badge"
const BADGE_STORE = "kv"
const BADGE_SEQ_KEY = "seq"

function openBadgeDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(BADGE_DB, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(BADGE_STORE)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function applyBadge(count, seq) {
    try {
        const db = await openBadgeDb()
        const stored = await new Promise((resolve, reject) => {
            const request = db.transaction(BADGE_STORE).objectStore(BADGE_STORE).get(BADGE_SEQ_KEY)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (typeof stored === "number" && seq < stored) return

        await new Promise((resolve, reject) => {
            const transaction = db.transaction(BADGE_STORE, "readwrite")
            transaction.objectStore(BADGE_STORE).put(seq, BADGE_SEQ_KEY)
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
        })

        if (count > 0) await self.navigator.setAppBadge?.(count)
        else await self.navigator.clearAppBadge?.()
    } catch {
        // バッジに非対応の環境では、通知の表示だけを行う
    }
}

self.addEventListener("push", (event) => {
    let data = {}
    try {
        data = event.data ? event.data.json() : {}
    } catch {
        data = { body: event.data ? event.data.text() : "" }
    }

    // 件数と通番を持つPush（ホスト・監視の通知）だけがバッジを動かす。AI利用枠の通知は持たない
    const hasBadge = Number.isInteger(data.badge) && Number.isInteger(data.seq)

    event.waitUntil(
        Promise.all([
            self.registration.showNotification(data.title || "StatusHub", {
                body: data.body || "",
                tag: data.tag,
                // 同じ枠の通知（90% → 100%）は置き換えるが、置き換えたときも知らせる
                renotify: Boolean(data.tag),
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                data: { url: data.url || "/" },
            }),
            hasBadge ? applyBadge(data.badge, data.seq) : undefined,
        ])
    )
})

self.addEventListener("notificationclick", (event) => {
    event.notification.close()
    const url = new URL(event.notification.data?.url || "/", self.location.origin)

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
            const existing = windows.find((client) => new URL(client.url).origin === url.origin)

            // 開いている画面があれば読み込み直さずに前へ出し、表示するタブだけを伝える
            if (existing) {
                await existing.focus()
                existing.postMessage({
                    type: "open-tab",
                    tab: url.searchParams.get("tab"),
                    panel: url.searchParams.get("panel"),
                })
                return
            }
            await self.clients.openWindow(url.href)
        })()
    )
})
