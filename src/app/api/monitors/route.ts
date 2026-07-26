import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { fetchUptimeRobotMonitorsServer } from "@/lib/uptimerobot"

export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    const monitors = await fetchUptimeRobotMonitorsServer()
    return NextResponse.json({ monitors })
}
