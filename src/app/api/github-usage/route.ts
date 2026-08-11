import { NextResponse } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getGitHubUsageSnapshot } from "@/lib/github-usage"

export const dynamic = "force-dynamic"

export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    try {
        const snapshot = await getGitHubUsageSnapshot()
        return NextResponse.json(snapshot, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("GitHub usage error:", error)
        return NextResponse.json({ error: "GitHubの使用状況を取得できませんでした" }, { status: 500 })
    }
}
