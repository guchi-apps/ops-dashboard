import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { enqueueCloseRequest } from "@/lib/host-stats/close-requests"
import { ID_PATTERN } from "@/lib/host-stats/report"
import { readSnapshot } from "@/lib/host-stats/store"
import { requireSessionForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * tmux セッションを閉じる依頼を受け付ける（#409）。
 *
 * ホストで実行するのはエージェントで、依頼は次の受信の応答で渡る（最大1分ほどかかる）。
 * **破壊的な操作のため、ログインセッションでだけ受け付ける**（`OPS_API_TOKEN` では通さない）。
 * `/api/tmux-close` は `src/proxy.ts` の認証除外に載せていないので、そちらでも守られる。
 *
 * `{ hostId, user, name }` — 直近の受信に載っているセッションと一致するものだけを受け付ける。
 */
export async function POST(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { hostId, user, name } = (payload ?? {}) as Record<string, unknown>
    if (typeof hostId !== "string" || !ID_PATTERN.test(hostId)) {
        return NextResponse.json({ error: "ホストの指定が正しくありません" }, { status: 400 })
    }

    const snapshot = await readSnapshot(hostId)
    const result = await enqueueCloseRequest(hostId, { user, name }, snapshot?.tmuxSessions ?? [])

    switch (result) {
        case "invalid":
            return NextResponse.json({ error: "セッションの指定が正しくありません" }, { status: 400 })
        case "unknown-session":
            return NextResponse.json(
                { error: "そのセッションはすでに一覧にありません" },
                { status: 404 }
            )
        default:
            return NextResponse.json({ ok: true, alreadyRequested: result === "exists" })
    }
}
