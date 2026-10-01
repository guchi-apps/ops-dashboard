import { NextResponse } from "next/server"

import { getAccessDb } from "@/lib/access/db"
import { handleAdminWrite } from "@/lib/access/admin-route"
import { AccessError, issueAppToken, revokeAppToken } from "@/lib/access/policy"

/**
 * アプリ別トークンの発行・再発行（POST）と失効（DELETE）。管理者のセッションのみ。
 *
 * 平文のトークンはこのレスポンスでしか返さない（DBにはハッシュだけを残す）。
 * `POST { id }` / `DELETE ?id=<appId>`
 */
export async function POST(request: Request) {
    return handleAdminWrite(request, (actor, body) => {
        if (typeof body.id !== "string") throw new AccessError("invalid", "id を指定してください")
        return { token: issueAppToken(getAccessDb(), actor, body.id, new Date()) }
    }).then((response) => {
        // トークンを含むレスポンスはキャッシュさせない
        response.headers.set("Cache-Control", "no-store")
        return response
    })
}

export async function DELETE(request: Request) {
    const id = new URL(request.url).searchParams.get("id")
    if (!id) return NextResponse.json({ error: "id を指定してください" }, { status: 400 })
    return handleAdminWrite(request, (actor) => {
        revokeAppToken(getAccessDb(), actor, id, new Date())
        return {}
    })
}
