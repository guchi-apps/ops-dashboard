import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { clearMonitorDisplayName, setMonitorDisplayName } from "@/lib/monitor-names"
import { isMonitorSource, MAX_DISPLAY_NAME_LENGTH } from "@/lib/monitor-source"
import { requireSessionForApi } from "@/lib/session"

/**
 * 監視モニターの表示名を変更する（#479）。Kuma・UptimeRobot 側の名前は変えない。
 *
 * `/api/monitors` などと違い、書き込みなので画面のセッションだけで通す
 * （`OPS_API_TOKEN` は読み取り用）。
 *
 * - `PUT { source: "kuma" | "robot", id: 12, name: "愛車メンテ" }` — 表示名を設定（空文字なら元に戻す）
 * - `DELETE ?source=kuma&id=12` — 元の名前に戻す
 */
export async function PUT(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { source, id, name } = (payload ?? {}) as Record<string, unknown>
    if (!isMonitorSource(source) || typeof id !== "number" || !Number.isInteger(id) || typeof name !== "string") {
        return NextResponse.json({ error: "source・id・name を正しく指定してください" }, { status: 400 })
    }

    const result = await setMonitorDisplayName(source, id, name)
    if (result === null) {
        return NextResponse.json(
            { error: `表示名は${MAX_DISPLAY_NAME_LENGTH}文字以内で入力してください` },
            { status: 400 }
        )
    }

    return NextResponse.json({ ok: true, cleared: result === "cleared" })
}

export async function DELETE(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    const source = request.nextUrl.searchParams.get("source")
    const id = Number(request.nextUrl.searchParams.get("id"))
    if (!isMonitorSource(source) || !Number.isInteger(id)) {
        return NextResponse.json({ error: "source と id を指定してください" }, { status: 400 })
    }

    await clearMonitorDisplayName(source, id)
    return NextResponse.json({ ok: true })
}
