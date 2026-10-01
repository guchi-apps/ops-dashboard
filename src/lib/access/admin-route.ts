import { NextResponse } from "next/server"

import { AccessEnvironmentMismatchError } from "@/lib/access/db"
import { AccessError } from "@/lib/access/policy"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireAdminForApi, type Session } from "@/lib/session"

/**
 * 管理用の更新APIルートの共通処理（#489）。管理者のセッション → CSRF → 本文の読み取りの順に確かめ、
 * `AccessError`（入力不正・最後の管理者の取り消しなど）を4xxへ変換する。
 */
export async function handleAdminWrite(
    request: Request,
    task: (actor: string, body: Record<string, unknown>, session: Session) => Promise<unknown> | unknown
): Promise<Response> {
    const { session, response } = await requireAdminForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    let body: Record<string, unknown> = {}
    if (request.method !== "DELETE") {
        try {
            const parsed: unknown = await request.json()
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object")
            body = parsed as Record<string, unknown>
        } catch {
            return NextResponse.json({ error: "JSONのオブジェクトとして読めませんでした" }, { status: 400 })
        }
    }

    try {
        const result = await task(session.user.email, body, session)
        return NextResponse.json({ ok: true, ...(result as object | undefined) })
    } catch (error) {
        if (error instanceof AccessError) {
            const status = error.code === "not_found" ? 404 : error.code === "last_admin" ? 409 : 400
            return NextResponse.json({ error: error.message, code: error.code }, { status })
        }
        if (error instanceof AccessEnvironmentMismatchError) {
            return NextResponse.json({ error: error.message }, { status: 503 })
        }
        console.error("[access] 更新に失敗:", error)
        return NextResponse.json({ error: "アクセス設定を更新できませんでした" }, { status: 500 })
    }
}
