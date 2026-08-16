import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { fetchUptimeKumaDashboardMonitors } from "@/lib/uptime-kuma"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    const monitors = await fetchUptimeKumaDashboardMonitors()
    return NextResponse.json({ monitors })
}
