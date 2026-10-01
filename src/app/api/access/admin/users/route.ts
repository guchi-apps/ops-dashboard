import { getAccessDb } from "@/lib/access/db"
import { handleAdminWrite } from "@/lib/access/admin-route"
import { AccessError, upsertUser, type Grants, type UserStatus } from "@/lib/access/policy"
import { invalidateStatusHubAccess } from "@/lib/access/status-hub"

/**
 * ユーザーの追加・権限の変更・取り消し（管理者のセッションのみ。#489）。
 *
 * `PUT { email, status?: "active" | "revoked", grants?: { "<appId>": ["<権限>", …] } }`
 * `grants` を渡すとアプリ別の権限をその内容へ丸ごと置き換える。取り消しは `status: "revoked"`
 * （履歴を残すため行は消さない）。最後の管理者を失う変更は409で拒否する。
 */
export async function PUT(request: Request) {
    return handleAdminWrite(request, (actor, body) => {
        const { email, status, grants } = body
        if (typeof email !== "string") throw new AccessError("invalid", "email を指定してください")
        if (status !== undefined && status !== "active" && status !== "revoked") {
            throw new AccessError("invalid", "status は active か revoked を指定してください")
        }

        let parsedGrants: Grants | undefined
        if (grants !== undefined) {
            if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
                throw new AccessError("invalid", "grants はアプリIDをキーとするオブジェクトで指定してください")
            }
            parsedGrants = {}
            for (const [appId, permissions] of Object.entries(grants)) {
                if (!Array.isArray(permissions) || !permissions.every((item) => typeof item === "string")) {
                    throw new AccessError("invalid", "権限は文字列の配列で指定してください")
                }
                parsedGrants[appId] = permissions as string[]
            }
        }

        const result = upsertUser(
            getAccessDb(),
            actor,
            { email, status: status as UserStatus | undefined, grants: parsedGrants },
            new Date()
        )
        // 取り消しをこのプロセスのログイン判定へ即座に効かせる
        invalidateStatusHubAccess()
        return { changed: result.changed }
    })
}
