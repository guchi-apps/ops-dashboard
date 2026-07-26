export type UptimeKumaStatus = "up" | "down" | "pending" | "maintenance"

export interface UptimeKumaMonitor {
    id: number
    name: string
    url?: string
    status: UptimeKumaStatus
    /** Oldest → newest, up to the last 25 heartbeats. */
    recentStatuses: UptimeKumaStatus[]
    currentPing: number | null
    avgPing: number | null
}

interface StatusPageResponse {
    publicGroupList: {
        monitorList: { id: number; name: string; url?: string }[]
    }[]
}

interface HeartbeatResponse {
    heartbeatList: Record<string, { status: number; ping: number | null }[]>
}

const RECENT_HEARTBEAT_COUNT = 25

function mapHeartbeatStatus(status: number): UptimeKumaStatus {
    switch (status) {
        case 1:
            return "up"
        case 0:
            return "down"
        case 3:
            return "maintenance"
        default:
            return "pending"
    }
}

async function fetchMonitorsForSlug(slug: string | undefined): Promise<UptimeKumaMonitor[]> {
    const baseUrl = process.env.UPTIMEKUMA_BASE_URL
    if (!baseUrl || !slug) {
        return []
    }

    try {
        const [pageRes, heartbeatRes] = await Promise.all([
            fetch(`${baseUrl}/api/status-page/${slug}`, { cache: "no-store" }),
            fetch(`${baseUrl}/api/status-page/heartbeat/${slug}`, { cache: "no-store" }),
        ])

        if (!pageRes.ok || !heartbeatRes.ok) {
            console.error("Uptime Kuma API Error:", pageRes.status, heartbeatRes.status)
            return []
        }

        const page = (await pageRes.json()) as StatusPageResponse
        const heartbeat = (await heartbeatRes.json()) as HeartbeatResponse
        const monitors = page.publicGroupList.flatMap((group) => group.monitorList)

        return monitors.map((monitor) => {
            const beats = (heartbeat.heartbeatList[String(monitor.id)] ?? []).slice(
                -RECENT_HEARTBEAT_COUNT
            )
            const recentStatuses = beats.map((beat) => mapHeartbeatStatus(beat.status))
            const last = beats[beats.length - 1]
            const status = last ? mapHeartbeatStatus(last.status) : "pending"
            const currentPing = last?.ping ?? null
            const pings = beats
                .map((beat) => beat.ping)
                .filter((ping): ping is number => typeof ping === "number")
            const avgPing =
                pings.length > 0
                    ? Math.round(pings.reduce((sum, ping) => sum + ping, 0) / pings.length)
                    : null

            return {
                id: monitor.id,
                name: monitor.name,
                url: monitor.url,
                status,
                recentStatuses,
                currentPing,
                avgPing,
            }
        })
    } catch (err) {
        console.error("Failed to fetch Uptime Kuma data:", err)
        return []
    }
}

export async function fetchUptimeKumaDashboardMonitors(): Promise<UptimeKumaMonitor[]> {
    return fetchMonitorsForSlug(process.env.UPTIMEKUMA_DASHBOARD_SLUG)
}
