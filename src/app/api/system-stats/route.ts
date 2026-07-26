import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getSystemStats } from "@/lib/system-stats"

export const dynamic = "force-dynamic"

export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    try {
        const stats = await getSystemStats()
        return NextResponse.json(stats, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("System stats error:", error)
        return NextResponse.json({ error: "Failed to read system stats" }, { status: 500 })
    }
}
