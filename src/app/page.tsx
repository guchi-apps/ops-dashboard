import { requireSessionForPage } from "@/lib/session"
import { AiUsage } from "@/components/ai-usage"
import { MonitorCard, MonitorCardGrid } from "@/components/monitor-card"
import { SectionHeading } from "@/components/section-heading"
import { ServerStats } from "@/components/server-stats"
import { Button, buttonVariants } from "@/components/ui/button"
import { UptimeKumaDashboardCard } from "@/components/uptime-kuma-card"
import { Plus } from "lucide-react"
import { fetchUptimeRobotMonitorsServer, getUptimeRobotStatusInfo } from "@/lib/uptimerobot"
import { fetchUptimeKumaDashboardMonitors, getUptimeKumaAddMonitorUrl } from "@/lib/uptime-kuma"

export const dynamic = "force-dynamic"

async function UptimeRobotSection() {
    const monitors = await fetchUptimeRobotMonitorsServer()

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading title="UptimeRobot" />
            {monitors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    UptimeRobot のモニターが取得できません。APIキーを確認してください。
                </p>
            ) : (
                <MonitorCardGrid count={monitors.length}>
                    {monitors.map((monitor) => {
                        const status = getUptimeRobotStatusInfo(monitor.status)
                        const ratioStr = monitor.custom_uptime_ratio || monitor.uptime_ratio || "0"
                        const ratio = parseFloat(ratioStr.split("-")[0])
                        return (
                            <MonitorCard
                                key={monitor.id}
                                label={monitor.friendly_name}
                                statusText={status.text}
                                statusColor={status.color}
                                uptimeLabel={`${ratio}% uptime (30d)`}
                                href={monitor.url}
                            />
                        )
                    })}
                </MonitorCardGrid>
            )}
        </section>
    )
}

async function UptimeKumaSection() {
    const monitors = await fetchUptimeKumaDashboardMonitors()
    if (monitors.length === 0) return null

    const addMonitorUrl = getUptimeKumaAddMonitorUrl()

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title="Uptime Kuma"
                trailing={
                    addMonitorUrl && (
                        <a
                            href={addMonitorUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                            <Plus aria-hidden />
                            モニター追加
                        </a>
                    )
                }
            />
            <MonitorCardGrid count={monitors.length}>
                {monitors.map((monitor) => (
                    <UptimeKumaDashboardCard key={monitor.id} monitor={monitor} />
                ))}
            </MonitorCardGrid>
        </section>
    )
}

export default async function Home() {
    const session = await requireSessionForPage()

    return (
        <div className="min-h-screen p-4 md:p-8">
            <div className="max-w-4xl mx-auto space-y-5 sm:space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h1 className="text-2xl font-bold shrink-0">ダッシュボード</h1>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                            {session.user.email}
                        </span>
                        <form action="/auth/signout" method="POST">
                            <Button variant="outline" type="submit">
                                ログアウト
                            </Button>
                        </form>
                    </div>
                </div>

                <ServerStats />
                <AiUsage />
                <UptimeKumaSection />
                <UptimeRobotSection />
            </div>
        </div>
    )
}
