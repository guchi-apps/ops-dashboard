import type { Metadata } from "next"
import Link from "next/link"

import { changelog } from "@/data/changelog"
import { SectionHeading } from "@/components/section-heading"
import { DashboardCard } from "@/components/dashboard-card"

export const metadata: Metadata = {
    title: "更新履歴 | ops-dashboard",
}

export default function ChangelogPage() {
    return (
        <div className="min-h-screen p-4 md:p-8">
            <div className="max-w-4xl mx-auto space-y-6">
                <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold shrink-0">更新履歴</h1>
                    <Link
                        href="/"
                        className="ml-auto text-sm text-blue-600 hover:underline dark:text-blue-400"
                    >
                        ダッシュボードに戻る
                    </Link>
                </div>

                <div className="space-y-6">
                    {changelog.map((entry) => (
                        <section key={entry.version} className="space-y-4">
                            <SectionHeading
                                title={`v${entry.version}`}
                                trailing={
                                    <span className="text-sm text-slate-500 dark:text-slate-400">
                                        {entry.date}
                                    </span>
                                }
                            />
                            <DashboardCard>
                                <ul className="list-disc list-inside space-y-1 text-sm">
                                    {entry.changes.map((change, index) => (
                                        <li key={index}>{change}</li>
                                    ))}
                                </ul>
                                {entry.usage && entry.usage.length > 0 && (
                                    <div className="mt-4 rounded-lg border border-border bg-muted/60 p-4">
                                        <h3 className="text-sm font-semibold text-foreground">
                                            使い方
                                        </h3>
                                        <ol className="mt-2 list-decimal list-outside space-y-1 pl-5 text-sm text-muted-foreground">
                                            {entry.usage.map((step, index) => (
                                                <li key={index}>{step}</li>
                                            ))}
                                        </ol>
                                    </div>
                                )}
                            </DashboardCard>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    )
}
