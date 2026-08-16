import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { fetchUptimeRobotMonitorsServer } from "@/lib/uptimerobot"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    const monitors = await fetchUptimeRobotMonitorsServer()
    return NextResponse.json({ monitors })
}
