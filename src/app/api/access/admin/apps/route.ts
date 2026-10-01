import { getAccessDb } from "@/lib/access/db"
import { handleAdminWrite } from "@/lib/access/admin-route"
import { AccessError, upsertApp } from "@/lib/access/policy"
import { invalidateStatusHubAccess } from "@/lib/access/status-hub"

/** 連携するアプリの登録・変更。`PUT { id, name, permissions: string[] }`（管理者のセッションのみ） */
export async function PUT(request: Request) {
    return handleAdminWrite(request, (actor, body) => {
        const { id, name, permissions } = body
        if (
            typeof id !== "string" ||
            typeof name !== "string" ||
            !Array.isArray(permissions) ||
            !permissions.every((item) => typeof item === "string")
        ) {
            throw new AccessError("invalid", "id・name・permissions を正しく指定してください")
        }
        upsertApp(getAccessDb(), actor, { id, name, permissions: permissions as string[] }, new Date())
        invalidateStatusHubAccess()
        return {}
    })
}
