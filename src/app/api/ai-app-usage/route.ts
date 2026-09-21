import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { getAiAppUsageSnapshot } from "@/lib/ai-app-usage"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    // ヘッダーの更新ボタンからの取得だけ、サーバー側のキャッシュを飛ばして取り直す
    const force = request.nextUrl.searchParams.get("force") === "1"

    try {
        const snapshot = await getAiAppUsageSnapshot({ force })
        return NextResponse.json(snapshot, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("AI app usage error:", error)
        return NextResponse.json({ error: "アプリ別のAI利用を取得できませんでした" }, { status: 500 })
    }
}
