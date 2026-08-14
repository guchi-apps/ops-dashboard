"use client"

import { Plus } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { MonitorCard, MonitorCardGrid } from "@/components/monitor-card"
import { SectionHeading } from "@/components/section-heading"
import { buttonVariants } from "@/components/ui/button"
import { UptimeKumaDashboardCard } from "@/components/uptime-kuma-card"
import { getUptimeRobotStatusInfo } from "@/lib/uptimerobot"

/**
 * 監視タブの中身。
 *
 * 概要タブのタイルは状態だけを詰めて並べるのに対して、こちらはheartbeatや応答時間まで出す。
 * モニター追加のURLはサーバー側の環境変数から作るため、ページから受け取る。
 */
export function MonitorSections({ addMonitorUrl }: { addMonitorUrl: string | null }) {
    const { uptimeKuma, uptimeRobot } = useDashboardData()

    return (
        <div className="space-y-5">
            {uptimeKuma.length > 0 && (
                <section className="space-y-3">
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
                    <MonitorCardGrid count={uptimeKuma.length}>
                        {uptimeKuma.map((monitor) => (
                            <UptimeKumaDashboardCard key={monitor.id} monitor={monitor} />
                        ))}
                    </MonitorCardGrid>
                </section>
            )}

            <section className="space-y-3">
                <SectionHeading title="UptimeRobot" />
                {uptimeRobot.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        UptimeRobot のモニターが取得できません。APIキーを確認してください。
                    </p>
                ) : (
                    <MonitorCardGrid count={uptimeRobot.length}>
                        {uptimeRobot.map((monitor) => {
                            const status = getUptimeRobotStatusInfo(monitor.status)
                            const ratio = parseFloat(
                                (monitor.custom_uptime_ratio || monitor.uptime_ratio || "0").split("-")[0]
                            )

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
        </div>
    )
}
