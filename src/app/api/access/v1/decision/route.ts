import { NextResponse } from "next/server"

import { getAccessDb } from "@/lib/access/db"
import {
    DECISION_TTL_SECONDS,
    MAX_STALE_SECONDS,
    decideAccess,
    findAppByToken,
    getEnvironment,
    normalizeEmail,
    recordCheckin,
} from "@/lib/access/policy"

export const dynamic = "force-dynamic"

/**
 * 各アプリへ「認証済み利用者の許可・拒否・権限」を渡す契約API（#489。docs/access-control.md）。
 *
 * `/api/access/v1` は src/proxy.ts の認証対象外で、ここで**アプリ別トークン**（`Authorization: Bearer`）
 * を照合する。トークンは発行したアプリの判定だけを引け、ほかのアプリの設定や変更APIには使えない。
 * 呼び出し元のアプリが自分のサーバーで検証したメール・`sub` を送る形で、ブラウザが申告した
 * メールをそのまま送ってはならない（契約）。メールをURLに載せないよう POST にしている。
 *
 * - `POST { appliedVersion?: number, subject?: { sub, email, emailVerified } }`
 * - `subject` を省くと、判定なしの確認（ハートビート）として版だけを返す
 * - 呼び出しのたびに `appliedVersion`（アプリが適用中と申告する版）と時刻を記録し、反映状況に使う
 * - 5xx・ネットワーク失敗のときアプリは、直前の判定を `maxStaleSeconds` まで使い、超えたら拒否する
 */
export async function POST(request: Request) {
    const noStore = { "Cache-Control": "no-store" }

    try {
        const authorization = request.headers.get("authorization")
        const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""

        const db = getAccessDb()
        const app = findAppByToken(db, token)
        if (!app) {
            return NextResponse.json({ error: "認証が必要です" }, { status: 401, headers: noStore })
        }

        const now = new Date()
        let payload: unknown
        try {
            payload = await request.json()
        } catch {
            recordCheckin(db, app.id, { appliedVersion: null, ok: false, error: "リクエストの形式が不正です" }, now)
            return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400, headers: noStore })
        }

        const body = (payload ?? {}) as { appliedVersion?: unknown; subject?: unknown }
        const applied = body.appliedVersion
        if (applied !== undefined && applied !== null && (typeof applied !== "number" || !Number.isInteger(applied))) {
            recordCheckin(db, app.id, { appliedVersion: null, ok: false, error: "appliedVersionが不正です" }, now)
            return NextResponse.json({ error: "appliedVersion は整数で指定してください" }, { status: 400, headers: noStore })
        }

        const base = {
            environment: getEnvironment(db),
            appVersion: app.version,
            ttlSeconds: DECISION_TTL_SECONDS,
            maxStaleSeconds: MAX_STALE_SECONDS,
        }

        let decision: { allowed: boolean; permissions: string[]; reason?: string } | undefined
        if (body.subject !== undefined) {
            const subject = (body.subject ?? {}) as Record<string, unknown>
            const email = normalizeEmail(subject.email)
            if (typeof subject.sub !== "string" || subject.sub === "" || !email || subject.emailVerified !== true) {
                // 検証済みのIDとメールが揃わないものは判定しない
                decision = { allowed: false, permissions: [], reason: "unverified_identity" }
            } else {
                const result = decideAccess(db, app.id, email)
                decision = result.allowed
                    ? { allowed: true, permissions: result.permissions }
                    : { allowed: false, permissions: [], reason: result.reason }
            }
        }

        recordCheckin(db, app.id, { appliedVersion: typeof applied === "number" ? applied : null, ok: true }, now)
        return NextResponse.json(decision ? { ...base, decision } : base, { headers: noStore })
    } catch (error) {
        console.error("[access] 判定APIでエラー:", error)
        return NextResponse.json({ error: "アクセス設定を読めません" }, { status: 503, headers: noStore })
    }
}
