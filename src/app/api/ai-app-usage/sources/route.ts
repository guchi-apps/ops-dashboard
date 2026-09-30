import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { invalidateAiAppUsageCache } from "@/lib/ai-app-usage"
import {
    AiAppUsageSourcesError,
    getAiAppUsageSources,
    saveAiAppUsageSources,
} from "@/lib/ai-app-usage/sources"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireSessionOrAiAppUsageSourcesWriteToken } from "@/lib/session"

export const dynamic = "force-dynamic"

/** ログイン画面と自動更新エージェントの両方へ、現在の連携先を返す。 */
export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrAiAppUsageSourcesWriteToken(request)
    if (response) return response

    const result = await getAiAppUsageSources()
    if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ sources: result.sources }, { headers: { "Cache-Control": "no-store" } })
}

/** `{ sources: [{ app, url }] }` で連携先一覧を丸ごと置き換える。 */
export async function PUT(request: NextRequest) {
    const { response, caller } = await requireSessionOrAiAppUsageSourcesWriteToken(request)
    if (response) return response
    if (caller.kind === "session") {
        const rejected = rejectCrossSiteRequest(request)
        if (rejected) return rejected
    }

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSON形式で指定してください" }, { status: 400 })
    }

    const sources = payload && typeof payload === "object" ? (payload as { sources?: unknown }).sources : undefined
    try {
        const saved = await saveAiAppUsageSources(sources)
        invalidateAiAppUsageCache()
        return NextResponse.json({ sources: saved })
    } catch (error) {
        const message = error instanceof AiAppUsageSourcesError ? error.message : "連携先の設定を保存できません"
        return NextResponse.json({ error: message }, { status: 400 })
    }
}
