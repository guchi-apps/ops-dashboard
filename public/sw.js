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

self.addEventListener("push", (event) => {
    let data = {}
    try {
        data = event.data ? event.data.json() : {}
    } catch {
        data = { body: event.data ? event.data.text() : "" }
    }

    event.waitUntil(
        self.registration.showNotification(data.title || "StatusHub", {
            body: data.body || "",
            tag: data.tag,
            // 同じ枠の通知（90% → 100%）は置き換えるが、置き換えたときも知らせる
            renotify: Boolean(data.tag),
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png",
            data: { url: data.url || "/" },
        })
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
                existing.postMessage({ type: "open-tab", tab: url.searchParams.get("tab") })
                return
            }
            await self.clients.openWindow(url.href)
        })()
    )
})
