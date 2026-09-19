import { monitorFeedError, monitorFeedOk, type MonitorFeed } from "@/lib/monitor-feed"

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

const UNEXPECTED_SHAPE = "応答の形式が想定と異なります"

/** 応答の骨格だけを確かめる。形が違うまま読み進めると、例外で握りつぶされて原因が見えなくなる */
function hasExpectedShape(page: unknown, heartbeat: unknown): boolean {
    const groups = (page as Partial<StatusPageResponse> | null)?.publicGroupList
    const beats = (heartbeat as Partial<HeartbeatResponse> | null)?.heartbeatList

    return (
        Array.isArray(groups) &&
        groups.every((group) => Array.isArray(group?.monitorList)) &&
        typeof beats === "object" &&
        beats !== null
    )
}

/**
 * 未設定（ベースURL・スラッグが無い）は失敗ではなく「監視が無い」として `error: null` で返す。
 * 設定があるのに取れなかったときだけ `error` を立てる。
 */
async function fetchMonitorsForSlug(
    slug: string | undefined
): Promise<MonitorFeed<UptimeKumaMonitor>> {
    const baseUrl = process.env.UPTIMEKUMA_BASE_URL
    if (!baseUrl || !slug) {
        return monitorFeedOk([])
    }

    try {
        const [pageRes, heartbeatRes] = await Promise.all([
            fetch(`${baseUrl}/api/status-page/${slug}`, { cache: "no-store" }),
            fetch(`${baseUrl}/api/status-page/heartbeat/${slug}`, { cache: "no-store" }),
        ])

        if (!pageRes.ok || !heartbeatRes.ok) {
            console.error("Uptime Kuma API Error:", pageRes.status, heartbeatRes.status)
            return monitorFeedError(`HTTP ${pageRes.ok ? heartbeatRes.status : pageRes.status}`)
        }

        const page: unknown = await pageRes.json()
        const heartbeat: unknown = await heartbeatRes.json()
        if (!hasExpectedShape(page, heartbeat)) {
            console.error("Uptime Kuma API returned an unexpected shape")
            return monitorFeedError(UNEXPECTED_SHAPE)
        }

        const { publicGroupList } = page as StatusPageResponse
        const { heartbeatList } = heartbeat as HeartbeatResponse
        const monitors = publicGroupList.flatMap((group) => group.monitorList)

        const mapped = monitors.map((monitor) => {
            const beats = (heartbeatList[String(monitor.id)] ?? []).slice(
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

        return monitorFeedOk(mapped)
    } catch (err) {
        console.error("Failed to fetch Uptime Kuma data:", err)
        // JSONとして読めなかった（プロキシのHTML応答など）ときと、接続できなかったときを分ける
        return monitorFeedError(err instanceof SyntaxError ? UNEXPECTED_SHAPE : "接続できません")
    }
}

export async function fetchUptimeKumaDashboardMonitors(): Promise<
    MonitorFeed<UptimeKumaMonitor>
> {
    return fetchMonitorsForSlug(process.env.UPTIMEKUMA_DASHBOARD_SLUG)
}

/** Uptime Kuma のモニター追加画面のURL。ベースURL未設定なら null。 */
export function getUptimeKumaAddMonitorUrl(): string | null {
    const baseUrl = process.env.UPTIMEKUMA_BASE_URL
    if (!baseUrl) return null

    return `${baseUrl.replace(/\/+$/, "")}/add`
}
