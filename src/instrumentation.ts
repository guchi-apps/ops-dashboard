/**
 * サーバー起動時に1回だけ呼ばれる（Next.js の instrumentation）。
 *
 * ホスト停止・再起動の検知は、画面の表示や停止したホストからの次回POSTに頼れないため、
 * VPSのプロセス内で定期的に判定する（#495）。PM2は fork モード1プロセスのため、プロセス内の
 * タイマーで足りる。`next build` では `register` は呼ばれず、Edgeでは動かさない。
 */

const INTERVAL_MS = 30_000

export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return

    const globalForTimer = globalThis as unknown as { __incidentTimer?: ReturnType<typeof setInterval> }
    if (globalForTimer.__incidentTimer) return

    const { runIncidentCheck } = await import("@/lib/incidents/run")
    const tick = () => {
        runIncidentCheck().catch((error) => console.error("[incidents] 判定に失敗しました:", error))
    }

    globalForTimer.__incidentTimer = setInterval(tick, INTERVAL_MS)
    // プロセスの終了を止めない
    globalForTimer.__incidentTimer.unref?.()
    tick()
}
