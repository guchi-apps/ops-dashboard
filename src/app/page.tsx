import { requireSessionForPage } from "@/lib/session"
import { DashboardDataProvider } from "@/components/dashboard-data"
import { DashboardShell } from "@/components/dashboard-shell"
import { fetchUptimeRobotMonitorsServer } from "@/lib/uptimerobot"
import { fetchUptimeKumaDashboardMonitors, getUptimeKumaAddMonitorUrl } from "@/lib/uptime-kuma"
import { isUptimeKumaAdminConfigured } from "@/lib/uptime-kuma-admin"

export const dynamic = "force-dynamic"

export default async function Home() {
    const session = await requireSessionForPage()

    // 初回描画で監視の枠が空にならないよう、サーバー側で取った値を初期値として渡す
    const [uptimeKuma, uptimeRobot] = await Promise.all([
        fetchUptimeKumaDashboardMonitors(),
        fetchUptimeRobotMonitorsServer(),
    ])

    return (
        <DashboardDataProvider initial={{ uptimeKuma, uptimeRobot }}>
            <DashboardShell
                userEmail={session.user.email ?? ""}
                // モニター追加のURLと、画面から直接登録できるかの判定はサーバー側の
                // 環境変数から決まるため、ここで解決して渡す
                addMonitorUrl={getUptimeKumaAddMonitorUrl()}
                canAddMonitor={isUptimeKumaAdminConfigured()}
            />
        </DashboardDataProvider>
    )
}
