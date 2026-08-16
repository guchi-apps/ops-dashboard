import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { getGitHubUsageSnapshot } from "@/lib/github-usage"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
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
