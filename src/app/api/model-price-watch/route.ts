import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getPriceWatchView } from "@/lib/ai-app-usage/price-watch/run"

export const dynamic = "force-dynamic"

/**
 * モデル単価表の定期チェックの結果（#497）。単価表の画面が、最終チェック・結果・更新候補を出すために読む。
 * チェック自体は `src/instrumentation.ts` のタイマーが行い、このルートは保存済みの結果を返すだけ
 * （画面を開いても公式ページへは取りにいかない）。ログインセッションでだけ返す。
 */
export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    try {
        return NextResponse.json(await getPriceWatchView(), { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("Model price watch read error:", error)
        return NextResponse.json({ error: "Failed to read model price watch" }, { status: 500 })
    }
}
