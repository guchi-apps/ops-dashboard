import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getClaudeUsageForWidget } from "@/lib/claude-usage"
import { describeError } from "@/lib/upstream"

export const dynamic = "force-dynamic"

/**
 * iPhone のロック画面ウィジェット（Scriptable）から叩く中継API。
 *
 * Scriptable は Supabase のログイン画面を通れないため、ダッシュボード本体の認証ではなく
 * 固定トークン（`WIDGET_TOKEN`）で認証する。このパスは src/proxy.ts の認証対象から除外している。
 */
export async function GET(request: NextRequest) {
    const widgetToken = process.env.WIDGET_TOKEN
    if (!widgetToken || request.headers.get("authorization") !== `Bearer ${widgetToken}`) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    try {
        const usage = await getClaudeUsageForWidget()
        return NextResponse.json(usage, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        // 取得できずキャッシュも無い状態。理由はウィジェット側に出したいのでそのまま返す
        return NextResponse.json({ error: describeError(error) }, { status: 503 })
    }
}
