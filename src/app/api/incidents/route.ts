import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getIncidentSnapshot } from "@/lib/incidents/run"

export const dynamic = "force-dynamic"

/**
 * 未解消エラーの件数と一覧（#495）。画面内の件数・一覧とPWAアイコンのバッジは、どちらもこの値から作る。
 * 件数は定期処理（`src/instrumentation.ts`）がサーバーで計算した値で、画面を開いても消えない。
 * 監視情報を含むため、ログインセッションでだけ返す（`OPS_API_TOKEN` では通さない）。
 */
export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    try {
        return NextResponse.json(await getIncidentSnapshot(), { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("Incidents read error:", error)
        return NextResponse.json({ error: "Failed to read incidents" }, { status: 500 })
    }
}
