import { AccessAdmin } from "@/components/access-admin"
import { buildAccessState, type AccessState } from "@/lib/access/state"
import { requireAdminForPage } from "@/lib/session"

export const dynamic = "force-dynamic"

export const metadata = { title: "アクセス管理 | StatusHub" }

/** 共通アクセス設定の管理画面（#489）。管理者だけが開ける（それ以外はトップへ戻す） */
export default async function AccessAdminPage() {
    const session = await requireAdminForPage()

    let initial: AccessState | null = null
    try {
        initial = buildAccessState()
    } catch (error) {
        console.error("[access] 状態の取得に失敗:", error)
    }
    return <AccessAdmin currentEmail={session.user.email} initial={initial} />
}
