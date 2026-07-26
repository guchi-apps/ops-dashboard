import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { fetchUptimeKumaDashboardMonitors } from "@/lib/uptime-kuma"

export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    const monitors = await fetchUptimeKumaDashboardMonitors()
    return NextResponse.json({ monitors })
}
