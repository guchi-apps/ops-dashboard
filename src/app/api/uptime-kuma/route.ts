import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { fetchUptimeKumaDashboardMonitors } from "@/lib/uptime-kuma"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    // { monitors, error }。取得に失敗しても200で返し、失敗は `error` で伝える
    const feed = await fetchUptimeKumaDashboardMonitors()
    return NextResponse.json(feed)
}
