import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { getOnePasswordUsageSnapshot } from "@/lib/onepassword-usage"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    try {
        const snapshot = await getOnePasswordUsageSnapshot()
        return NextResponse.json(snapshot, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("1Password usage error:", error)
        return NextResponse.json(
            { error: "1Passwordの使用状況を取得できませんでした" },
            { status: 500 }
        )
    }
}
