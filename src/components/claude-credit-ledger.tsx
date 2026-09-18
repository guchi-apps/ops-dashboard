"use client"

import { useId, useState } from "react"
import { Pencil, Trash2, X } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { Button } from "@/components/ui/button"
import type { ClaudeCreditLedgerView } from "@/types/ai-usage"

const INPUT_CLASS =
    "h-8 w-full rounded-md border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"

const ENDPOINT = "/api/ai-usage/claude-credits"

type SubmitState =
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "done"; message: string }
    | { kind: "error"; message: string }

/** ブラウザの暦で今日を YYYY-MM-DD にする（日付入力の既定値） */
function todayKey(): string {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")
    return `${now.getFullYear()}-${month}-${day}`
}

function formatUsd(amount: number): string {
    return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD" }).format(amount)
}

function formatCorrectedAt(iso: string): string {
    return new Date(iso).toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })
}

async function send(init: RequestInit & { url?: string }): Promise<string | null> {
    const res = await fetch(init.url ?? ENDPOINT, {
        ...init,
        headers: { "Content-Type": "application/json" },
    })
    if (res.ok) return null

    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    return payload.error ?? `記録に失敗しました（${res.status}）`
}

/**
 * Claudeのクレジット購入と残高の補正を記録するフォーム（#252）。
 *
 * claude.ai の残高・購入履歴はCloudflareに阻まれてサーバーから取れないため、Claude.aiの
 * 「使用クレジット」画面で見た値をここで登録する。残高は補正した時点から使用額を差し引いて推定される。
 */
export function ClaudeCreditLedger({ ledger }: { ledger: ClaudeCreditLedgerView }) {
    const { refreshAiUsage } = useDashboardData()
    const balanceId = useId()
    const dateId = useId()
    const amountId = useId()

    const [open, setOpen] = useState(false)
    const [balance, setBalance] = useState("")
    const [date, setDate] = useState(todayKey)
    const [amount, setAmount] = useState("")
    const [state, setState] = useState<SubmitState>({ kind: "idle" })

    const sending = state.kind === "sending"

    const run = async (task: () => Promise<string | null>, doneMessage: string) => {
        if (sending) return
        setState({ kind: "sending" })

        try {
            const error = await task()
            if (error) {
                setState({ kind: "error", message: error })
                return false
            }

            await refreshAiUsage()
            setState({ kind: "done", message: doneMessage })
            return true
        } catch {
            setState({ kind: "error", message: "記録に失敗しました。通信を確認してください。" })
            return false
        }
    }

    const submitBalance = async (event: React.FormEvent) => {
        event.preventDefault()
        const ok = await run(
            () => send({ method: "POST", body: JSON.stringify({ kind: "balance", amount: Number(balance) }) }),
            "残高を補正しました。"
        )
        if (ok) setBalance("")
    }

    const submitPurchase = async (event: React.FormEvent) => {
        event.preventDefault()
        const ok = await run(
            () =>
                send({
                    method: "POST",
                    body: JSON.stringify({ kind: "purchase", date, amount: Number(amount) }),
                }),
            "購入を記録しました。"
        )
        if (ok) setAmount("")
    }

    const removePurchase = (id: string) =>
        run(
            () => send({ method: "DELETE", url: `${ENDPOINT}?id=${encodeURIComponent(id)}` }),
            "購入を削除しました。"
        )

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] sm:text-xs text-muted-foreground">
                    {ledger.correctedAt && ledger.correctedBalanceText
                        ? `${formatCorrectedAt(ledger.correctedAt)} に ${ledger.correctedBalanceText} で補正`
                        : "残高は未補正です"}
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                        setOpen((current) => !current)
                        setState({ kind: "idle" })
                    }}
                    aria-expanded={open}
                >
                    {open ? <X aria-hidden /> : <Pencil aria-hidden />}
                    {open ? "閉じる" : "購入・残高を記録"}
                </Button>
            </div>

            {open && (
                <div className="space-y-3 rounded-md border p-2.5">
                    <form onSubmit={submitBalance} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                            <label htmlFor={balanceId} className="block text-[10px] sm:text-xs text-muted-foreground">
                                いまの残高（Claude.aiの画面の値。USD）
                            </label>
                            <input
                                id={balanceId}
                                className={INPUT_CLASS}
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="0.01"
                                value={balance}
                                onChange={(event) => setBalance(event.target.value)}
                                placeholder="11.19"
                                required
                                disabled={sending}
                            />
                        </div>
                        <Button type="submit" size="sm" variant="outline" disabled={sending}>
                            補正
                        </Button>
                    </form>

                    <form onSubmit={submitPurchase} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                            <label htmlFor={dateId} className="block text-[10px] sm:text-xs text-muted-foreground">
                                購入日
                            </label>
                            <input
                                id={dateId}
                                className={INPUT_CLASS}
                                type="date"
                                value={date}
                                onChange={(event) => setDate(event.target.value)}
                                required
                                disabled={sending}
                            />
                        </div>
                        <div className="w-24 shrink-0 space-y-1">
                            <label htmlFor={amountId} className="block text-[10px] sm:text-xs text-muted-foreground">
                                金額（USD）
                            </label>
                            <input
                                id={amountId}
                                className={INPUT_CLASS}
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                step="0.01"
                                value={amount}
                                onChange={(event) => setAmount(event.target.value)}
                                placeholder="10.15"
                                required
                                disabled={sending}
                            />
                        </div>
                        <Button type="submit" size="sm" variant="outline" disabled={sending}>
                            追加
                        </Button>
                    </form>

                    {ledger.purchases.length > 0 && (
                        <ul className="space-y-1">
                            {ledger.purchases.map((purchase) => (
                                <li
                                    key={purchase.id}
                                    className={`flex items-center justify-between gap-2 text-xs ${purchase.expired ? "opacity-50" : ""}`}
                                >
                                    <span className="min-w-0 truncate">
                                        {purchase.date}
                                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                                            {purchase.expired ? "期限切れ" : `〜${purchase.expiresOn}`}
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <span className="font-mono">+{formatUsd(purchase.amount)}</span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={() => void removePurchase(purchase.id)}
                                            disabled={sending}
                                            aria-label={`${purchase.date} の購入を削除`}
                                        >
                                            <Trash2 aria-hidden />
                                        </Button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {state.kind === "done" && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">{state.message}</p>
                    )}
                    {state.kind === "error" && <p className="text-xs text-destructive">{state.message}</p>}
                </div>
            )}
        </div>
    )
}
