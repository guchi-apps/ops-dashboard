import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken } from "@/lib/session"
import { HostStatsReportError, parseHostStatsReport } from "@/lib/host-stats/report"
import { getHostStatsView, saveHostStatsReport } from "@/lib/host-stats/store"

export const dynamic = "force-dynamic"

/** 想定されるペイロードは1KB前後。壊れた送信元にファイルを膨らませられないよう上限を設ける */
const MAX_BODY_BYTES = 32_768

/**
 * サブPCのメトリクスの受け口と取り出し口。
 *
 * VPS Status（自ホストの /proc を直読み）と違い、サブPCは自宅LAN内にいてVPSから
 * ポーリングできないため、サブPC側のエージェントから定期POSTしてもらう push 型にしている。
 *
 * - POST: エージェントからの受信。ログイン画面を通れないため `HOST_STATS_TOKEN` で認証する
 *   （このパスは src/proxy.ts の認証対象から除外している）
 * - GET: ダッシュボードからの取得。ログインセッション、またはサーバー間用の `OPS_API_TOKEN`
 *   で認証する（後者はAIDEのMCPサーバー向け。詳細は src/lib/session.ts）
 */
export async function POST(request: NextRequest) {
    const token = process.env.HOST_STATS_TOKEN
    if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const body = await request.text()
    if (body.length > MAX_BODY_BYTES) {
        return NextResponse.json({ error: "payload too large" }, { status: 413 })
    }

    let payload: unknown
    try {
        payload = JSON.parse(body)
    } catch {
        return NextResponse.json({ error: "JSONとして読めません" }, { status: 400 })
    }

    try {
        const report = parseHostStatsReport(payload)
        const snapshot = await saveHostStatsReport(report)
        return NextResponse.json({ ok: true, receivedAt: snapshot.receivedAt })
    } catch (error) {
        if (error instanceof HostStatsReportError) {
            return NextResponse.json({ error: error.message }, { status: 400 })
        }
        console.error("Host stats save error:", error)
        return NextResponse.json({ error: "Failed to save host stats" }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    try {
        const view = await getHostStatsView()
        return NextResponse.json(view, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("Host stats read error:", error)
        return NextResponse.json({ error: "Failed to read host stats" }, { status: 500 })
    }
}
