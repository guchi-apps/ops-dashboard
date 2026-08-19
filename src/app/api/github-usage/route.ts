import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { getGitHubUsageSnapshot } from "@/lib/github-usage"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    // ヘッダーの更新ボタンからの取得だけ、サーバー側のキャッシュを飛ばして取り直す
    const force = request.nextUrl.searchParams.get("force") === "1"

    try {
        const snapshot = await getGitHubUsageSnapshot({ force })
        return NextResponse.json(snapshot, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("GitHub usage error:", error)
        return NextResponse.json({ error: "GitHubの使用状況を取得できませんでした" }, { status: 500 })
    }
}
