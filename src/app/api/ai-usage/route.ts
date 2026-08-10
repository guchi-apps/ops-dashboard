import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getAiUsageSnapshot } from "@/lib/ai-usage"

export const dynamic = "force-dynamic"

export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    try {
        const snapshot = await getAiUsageSnapshot()
        return NextResponse.json(snapshot, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("AI usage error:", error)
        return NextResponse.json({ error: "AI使用状況を取得できませんでした" }, { status: 500 })
    }
}
