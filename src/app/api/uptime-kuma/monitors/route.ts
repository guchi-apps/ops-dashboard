import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrToken } from "@/lib/session"
import {
    addUptimeKumaMonitor,
    isUptimeKumaAdminConfigured,
    UptimeKumaAdminError,
} from "@/lib/uptime-kuma-admin"

/**
 * Uptime Kuma へモニターを登録する。
 *
 * 画面の「モニター追加」からも、新規アプリ作成の手順から `UPTIMEKUMA_ADMIN_TOKEN` を
 * 付けたサーバー間の呼び出しとしても叩ける。同じURLのモニターが既にあれば作らずにそれを
 * 返すため、手順を何度実行しても重複しない。
 *
 * **読み取り用の `OPS_API_TOKEN` では通さない。** あれは「サーバー間参照向けの読み取りAPI」
 * 用として配ってあるもので（README「サーバー間参照向けの読み取りAPI」）、相乗りさせると
 * 読み取りのつもりで渡したトークンで本番の監視設定を書き換えられるようになる。
 * `POST /api/host-stats` が `HOST_STATS_TOKEN` を持つのと同じく、専用トークンにしている。
 *
 * `/api/uptime-kuma` は src/proxy.ts の認証対象から外れており、この配下の保護は
 * ここだけが担う。Kumaへ書き込む唯一の経路なので、認証を外さないこと。
 */
export async function POST(request: NextRequest) {
    const { response } = await requireSessionOrToken(request, process.env.UPTIMEKUMA_ADMIN_TOKEN)
    if (response) return response

    if (!isUptimeKumaAdminConfigured()) {
        return NextResponse.json(
            { error: "Uptime Kuma の管理者認証情報が設定されていません" },
            { status: 503 }
        )
    }

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { name, url, interval, retries } = (payload ?? {}) as Record<string, unknown>
    if (typeof name !== "string" || typeof url !== "string") {
        return NextResponse.json({ error: "name と url は必須です" }, { status: 400 })
    }
    if (interval !== undefined && typeof interval !== "number") {
        return NextResponse.json({ error: "interval は数値で指定してください" }, { status: 400 })
    }
    if (retries !== undefined && typeof retries !== "number") {
        return NextResponse.json({ error: "retries は数値で指定してください" }, { status: 400 })
    }

    try {
        const result = await addUptimeKumaMonitor({ name, url, interval, retries })
        return NextResponse.json(result, { status: result.created ? 201 : 200 })
    } catch (error) {
        // 入力・設定が原因の失敗は理由をそのまま返す。Kumaの画面で手で追加すれば済むため、
        // 呼び出し側が「自動登録は無理だった」と判断できるようにする
        if (error instanceof UptimeKumaAdminError) {
            return NextResponse.json({ error: error.message }, { status: 502 })
        }

        console.error("Failed to add Uptime Kuma monitor:", error)
        return NextResponse.json({ error: "モニターの登録に失敗しました" }, { status: 500 })
    }
}
