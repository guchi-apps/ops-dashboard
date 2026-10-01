import { NextResponse } from "next/server"

import { buildAccessState } from "@/lib/access/state"
import { requireAdminForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/** 管理画面が読む全体の状態。管理者のセッションだけが読める（アプリ別トークンでは通らない） */
export async function GET() {
    const { response } = await requireAdminForApi()
    if (response) return response

    try {
        return NextResponse.json(buildAccessState(), { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        console.error("[access] 状態の取得に失敗:", error)
        return NextResponse.json({ error: "アクセス設定を読めません" }, { status: 503 })
    }
}
