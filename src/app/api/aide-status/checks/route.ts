import { NextResponse } from "next/server"
import { runAideStatusChecks } from "@/lib/aide-status"
import { requireSessionForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/** 画面の fetch が必ず付けるヘッダ。単純なフォーム送信では付けられない */
const REQUESTED_WITH = "ops-dashboard"

/**
 * AIDEの接続先の疎通確認（#237）。押したときだけ走らせる。
 *
 * AIDEが外部サービス（GitHub・DaySpan など）へ実際に問い合わせるため、他のサイトに置かれた
 * フォームから押させて問い合わせを踏ませないよう、ログインに加えて専用ヘッダを求める
 * （AIDE側の /status/checks と同じ扱い）。
 */
export async function POST(request: Request) {
    const { response } = await requireSessionForApi()
    if (response) return response

    if (request.headers.get("x-requested-with") !== REQUESTED_WITH) {
        return NextResponse.json({ error: "不正なリクエストです" }, { status: 403 })
    }

    const result = await runAideStatusChecks()
    return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store" },
    })
}
