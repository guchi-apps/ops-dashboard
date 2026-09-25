import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionForApi } from "@/lib/session"
import { getAiUsageSnapshot } from "@/lib/ai-usage"
import { isValidDateKey, toMinorUnits } from "@/lib/ai-usage/claude-credit-ledger"
import {
    addTypeSafeCreditPurchase,
    correctTypeSafeCreditBalance,
    removeTypeSafeCreditPurchase,
    TYPESAFE_LEDGER,
} from "@/lib/ai-usage/typesafe-credit-ledger"

/**
 * Jev（TypeSafe）のクレジット購入・残高の補正を記録する（#426）。Claudeの `claude-credits` と同じ形。
 *
 * `/api/ai-usage` 配下は src/proxy.ts の認証対象から外れているため、ここで必ずセッションを確かめる。
 * 読み取り用の `OPS_API_TOKEN` では通さない（書き込みのため、画面から操作したときだけ受け付ける）。
 *
 * - `{ kind: "purchase", date: "YYYY-MM-DD", amount: 10.15 }` — 購入を追加する
 * - `{ kind: "balance", amount: 11.19 }` — いまの残高で推定をやり直す
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

    const { kind, date, amount } = (payload ?? {}) as Record<string, unknown>
    const amountMinor = typeof amount === "number" ? toMinorUnits(amount, TYPESAFE_LEDGER) : null
    if (amountMinor === null) {
        return NextResponse.json({ error: "金額は0以上の数値で指定してください" }, { status: 400 })
    }

    if (kind === "purchase") {
        if (typeof date !== "string" || !isValidDateKey(date)) {
            return NextResponse.json({ error: "購入日は YYYY-MM-DD で指定してください" }, { status: 400 })
        }
        if (amountMinor === 0) {
            return NextResponse.json({ error: "購入額は0より大きい値で指定してください" }, { status: 400 })
        }

        await addTypeSafeCreditPurchase(date, amountMinor)
        return NextResponse.json({ ok: true }, { status: 201 })
    }

    if (kind === "balance") {
        // 補正時点の使用額を起点にするため、先に使用状況を観測しておく（キャッシュが新しければそれを使う）
        await getAiUsageSnapshot().catch((error) => {
            console.error("TypeSafe credits: 補正前の使用状況の取得に失敗", error)
        })
        await correctTypeSafeCreditBalance(amountMinor)
        return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: "kind は purchase か balance で指定してください" }, { status: 400 })
}

/** `?id=<購入のID>` の購入を削除する */
export async function DELETE(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    const id = request.nextUrl.searchParams.get("id")
    if (!id) {
        return NextResponse.json({ error: "id を指定してください" }, { status: 400 })
    }

    const removed = await removeTypeSafeCreditPurchase(id)
    if (!removed) {
        return NextResponse.json({ error: "その購入は見つかりませんでした" }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
}
