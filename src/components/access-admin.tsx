"use client"

import Link from "next/link"
import { useCallback, useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, Copy, KeyRound, Pencil, Plus } from "lucide-react"
import { Panel } from "@/components/panel"
import { StatusBadge, type StatusTone } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import type { AccessState } from "@/lib/access/state"
import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { cn } from "@/lib/utils"

/**
 * アクセス管理の画面（#489）。ユーザー・アプリ・監査履歴の3タブ。
 * 更新はすべて `/api/access/admin/*`（管理者のセッション＋CSRFヘッダ）へ送る。
 */

type State = AccessState
type AppState = State["apps"][number]
type UserState = State["users"][number]
type SyncStatus = AppState["sync"]["status"]

const STATUS_HUB = "status-hub"
const SYNC_LABEL: Record<SyncStatus, { label: string; tone: StatusTone }> = {
    unlinked: { label: "未連携", tone: "neutral" },
    pending: { label: "反映待ち", tone: "warn" },
    synced: { label: "反映済み", tone: "ok" },
    failed: { label: "取得失敗", tone: "danger" },
}
const ACTION_LABEL: Record<string, string> = {
    "user.create": "ユーザーを追加",
    "user.update": "権限を変更",
    "user.revoke": "ユーザーを取り消し",
    "user.restore": "取り消しを解除",
    "user.import": "既存の許可から取り込み",
    "app.create": "アプリを登録",
    "app.update": "アプリの定義を変更",
    "token.issue": "トークンを発行",
    "token.reissue": "トークンを再発行",
    "token.revoke": "トークンを失効",
    "token.shared_write": "共有トークンへ書き込み",
}
const TABS = [
    { id: "users", label: "ユーザー" },
    { id: "apps", label: "アプリ" },
    { id: "audit", label: "監査履歴" },
] as const
type TabId = (typeof TABS)[number]["id"]

/** アプリ登録で選べる標準の権限。これ以外は「その他の権限」として追加する（#512） */
const PRESET_PERMISSIONS = [
    { value: "viewer", description: "閲覧のみ" },
    { value: "member", description: "通常の利用" },
    { value: "editor", description: "内容の編集" },
    { value: "admin", description: "アプリ内の管理操作" },
] as const
/** サーバー（`policy.ts` の PERMISSION_PATTERN）と同じ形式 */
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,29}$/
const MAX_PERMISSIONS = 12

const INPUT_CLASS =
    "h-9 w-full rounded-md border bg-background px-3 text-base outline-none sm:text-sm transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"

function formatTime(iso: string | null): string {
    if (!iso) return "—"
    return new Date(iso).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })
}

async function send(method: "PUT" | "POST" | "DELETE", url: string, body?: unknown) {
    const res = await fetch(url, {
        method,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...CSRF_HEADERS },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = (await res.json().catch(() => null)) as ({ error?: string } & Record<string, unknown>) | null
    if (!res.ok) throw new Error(payload?.error ?? `保存に失敗しました（${res.status}）`)
    return payload ?? {}
}

export function AccessAdmin({ currentEmail, initial }: { currentEmail: string; initial: State | null }) {
    const [state, setState] = useState<State | null>(initial)
    const [error, setError] = useState<string | null>(initial ? null : "アクセス設定を読めません")
    const [tab, setTab] = useState<TabId>("users")
    const [userDialog, setUserDialog] = useState<UserState | "new" | null>(null)
    const [appDialog, setAppDialog] = useState<AppState | "new" | null>(null)
    const [tokenApp, setTokenApp] = useState<AppState | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/access/admin/state", { cache: "no-store" })
            if (!res.ok) throw new Error(`取得に失敗しました（${res.status}）`)
            setState((await res.json()) as State)
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : "取得に失敗しました")
        }
    }, [])

    useEffect(() => {
        // 反映状況は各アプリの確認で変わるため、開いている間は定期的に読み直す
        const timer = window.setInterval(() => void load(), 30_000)
        return () => window.clearInterval(timer)
    }, [load])

    const appName = (id: string) => state?.apps.find((app) => app.id === id)?.name ?? id

    return (
        <div className="mx-auto w-full max-w-[1200px] px-3 pb-6 pt-3 sm:px-5 sm:pt-4">
            <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="h-5 w-1 shrink-0 rounded-full bg-highlight" aria-hidden />
                <h1 className="text-base font-bold sm:text-lg">アクセス管理</h1>
                {state && (
                    <StatusBadge tone={state.environment === "production" ? "info" : "neutral"}>
                        {state.environment === "production" ? "本番" : "開発"}
                    </StatusBadge>
                )}
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => (window.location.href = "/")}>
                    <ArrowLeft aria-hidden />
                    ダッシュボードへ
                </Button>
            </header>

            <div role="tablist" aria-label="表示の切り替え" className="mb-3 flex gap-1 border-b border-border">
                {TABS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        onClick={() => setTab(item.id)}
                        className={cn(
                            "shrink-0 border-b-2 px-3 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            tab === item.id
                                ? "border-highlight font-bold text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            {error && (
                <p role="alert" className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {error}
                </p>
            )}
            {!state && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}

            {state && tab === "users" && (
                <Panel
                    title="ユーザー"
                    trailing={
                        <Button size="sm" className="ml-auto" onClick={() => setUserDialog("new")}>
                            <Plus aria-hidden />
                            ユーザーを追加
                        </Button>
                    }
                >
                    <ul className="divide-y divide-border">
                        {state.users.map((user) => (
                            <li key={user.email} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                                <div className="min-w-0 flex-1 basis-56">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-sm font-bold [overflow-wrap:anywhere]">{user.email}</span>
                                        {user.grants[STATUS_HUB]?.includes("admin") && <StatusBadge tone="ok">管理者</StatusBadge>}
                                        {user.status === "revoked" && <StatusBadge tone="danger">取り消し済み</StatusBadge>}
                                        {user.email === currentEmail && <StatusBadge tone="neutral">自分</StatusBadge>}
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {Object.entries(user.grants).length === 0 ? (
                                            <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground line-through">
                                                すべて拒否
                                            </span>
                                        ) : (
                                            Object.entries(user.grants).map(([appId, permissions]) => (
                                                <span key={appId} className="rounded border border-border px-1.5 text-[11px]">
                                                    {appName(appId)}: {permissions.join(" / ")}
                                                </span>
                                            ))
                                        )}
                                    </div>
                                </div>
                                <span className="text-[11px] text-muted-foreground tabular-nums">更新 {formatTime(user.updatedAt)}</span>
                                <Button variant="outline" size="sm" onClick={() => setUserDialog(user)} aria-label={`${user.email}を編集`}>
                                    <Pencil aria-hidden />
                                    編集
                                </Button>
                            </li>
                        ))}
                        {state.users.length === 0 && <li className="py-3 text-sm text-muted-foreground">ユーザーがいません</li>}
                    </ul>
                </Panel>
            )}

            {state && tab === "apps" && (
                <Panel
                    title="アプリの反映状況"
                    trailing={
                        <Button size="sm" className="ml-auto" onClick={() => setAppDialog("new")}>
                            <Plus aria-hidden />
                            アプリを登録
                        </Button>
                    }
                >
                    <p className="mb-2 text-[11px] text-muted-foreground">
                        反映状況は、各アプリが確認のたびに申告する版からStatusHubが推定した値です。保存に成功しただけでは「反映済み」になりません。
                    </p>
                    <ul className="divide-y divide-border">
                        {state.apps.map((app) => {
                            const sync = SYNC_LABEL[app.sync.status]
                            return (
                                <li key={app.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                                    <div className="min-w-0 flex-1 basis-56">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="text-sm font-bold">{app.name}</span>
                                            <span className="font-mono text-[11px] text-muted-foreground">{app.id}</span>
                                            <StatusBadge tone={sync.tone} withDot>
                                                {sync.label}
                                            </StatusBadge>
                                        </div>
                                        <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                                            保存 v{app.version} ・ 確認済み {app.sync.appliedVersion === null ? "—" : `v${app.sync.appliedVersion}`} ・ 最終確認{" "}
                                            {formatTime(app.sync.lastSeenAt)}
                                            {app.sync.detail && <span className="text-red-300"> ・ {app.sync.detail}</span>}
                                        </div>
                                        <div className="mt-1 text-[11px] text-muted-foreground">権限: {app.permissions.join(" / ")}</div>
                                    </div>
                                    {app.id !== STATUS_HUB && (
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" onClick={() => setTokenApp(app)}>
                                                <KeyRound aria-hidden />
                                                {app.hasToken ? "トークン" : "トークン発行"}
                                            </Button>
                                            <Button variant="outline" size="sm" onClick={() => setAppDialog(app)} aria-label={`${app.name}を編集`}>
                                                <Pencil aria-hidden />
                                                編集
                                            </Button>
                                        </div>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                </Panel>
            )}

            {state && tab === "audit" && (
                <Panel title="監査履歴">
                    <ul className="divide-y divide-border">
                        {state.audit.map((entry) => (
                            <li key={entry.id} className="py-2.5 text-sm">
                                <div className="[overflow-wrap:anywhere]">
                                    <span className="font-bold">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                                    <span className="text-muted-foreground"> ・ {entry.target}</span>
                                </div>
                                <div className="text-[11px] text-muted-foreground tabular-nums [overflow-wrap:anywhere]">
                                    {formatTime(entry.at)} ・ 変更者 {entry.actor}
                                </div>
                                {(entry.before !== null || entry.after !== null) && (
                                    <details className="mt-1 text-[11px] text-muted-foreground">
                                        <summary className="cursor-pointer">変更前後</summary>
                                        <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 font-mono">
                                            {`変更前: ${JSON.stringify(entry.before)}\n変更後: ${JSON.stringify(entry.after)}`}
                                        </pre>
                                    </details>
                                )}
                            </li>
                        ))}
                        {state.audit.length === 0 && <li className="py-3 text-sm text-muted-foreground">履歴はまだありません</li>}
                    </ul>
                </Panel>
            )}

            {state && userDialog && (
                <UserDialog
                    apps={state.apps}
                    user={userDialog === "new" ? null : userDialog}
                    isSelf={userDialog !== "new" && userDialog.email === currentEmail}
                    onClose={() => setUserDialog(null)}
                    onSaved={() => {
                        setUserDialog(null)
                        void load()
                    }}
                />
            )}
            {state && appDialog && (
                <AppDialog
                    app={appDialog === "new" ? null : appDialog}
                    onClose={() => setAppDialog(null)}
                    onSaved={() => {
                        setAppDialog(null)
                        void load()
                    }}
                />
            )}
            {tokenApp && (
                <TokenDialog
                    app={tokenApp}
                    onClose={() => {
                        setTokenApp(null)
                        void load()
                    }}
                />
            )}
            <p className="mt-4 text-[11px] text-muted-foreground">
                契約・反映時間・復旧手順は <Link href="https://github.com/guchi-apps/status-hub/blob/develop/docs/access-control.md" className="underline">docs/access-control.md</Link> を参照。
            </p>
        </div>
    )
}

/** 画面の下から出るシート（PCは中央）。body 直下へ portal で出す（monitor-name-editor.tsx と同じ） */
function Dialog({ title, onClose, onSubmit, children }: { title: string; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
    useEffect(() => {
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKeyDown)
        return () => {
            window.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
        }
    }, [onClose])

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5" onClick={onClose}>
            <form
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                    event.preventDefault()
                    onSubmit()
                }}
                className="flex max-h-[90vh] w-full max-w-[480px] flex-col gap-3 overflow-y-auto rounded-t-2xl border border-border bg-popover p-4 pb-7 text-popover-foreground shadow-2xl sm:rounded-2xl sm:pb-4"
            >
                <h3 className="text-sm font-bold">{title}</h3>
                {children}
            </form>
        </div>,
        document.body
    )
}

function Footer({ sending, onClose, submitLabel = "保存", disabled = false }: { sending: boolean; onClose: () => void; submitLabel?: string; disabled?: boolean }) {
    return (
        <div className="flex gap-2">
            <span className="hidden flex-1 sm:block" />
            <Button type="button" variant="outline" size="sm" onClick={onClose} className="hidden sm:inline-flex">
                キャンセル
            </Button>
            <Button type="submit" size="sm" disabled={sending || disabled} className="flex-1 sm:flex-none">
                {sending ? "保存中…" : submitLabel}
            </Button>
        </div>
    )
}

function ErrorLine({ message }: { message: string | null }) {
    return message ? (
        <p role="alert" className="text-sm text-destructive">
            {message}
        </p>
    ) : null
}

function UserDialog({ apps, user, isSelf, onClose, onSaved }: { apps: AppState[]; user: UserState | null; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
    const emailId = useId()
    const [email, setEmail] = useState(user?.email ?? "")
    const [status, setStatus] = useState<"active" | "revoked">(user?.status ?? "active")
    const [grants, setGrants] = useState<Record<string, string[]>>(user?.grants ?? {})
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const toggle = (appId: string, permission: string) =>
        setGrants((current) => {
            const list = current[appId] ?? []
            const next = list.includes(permission) ? list.filter((item) => item !== permission) : [...list, permission]
            return { ...current, [appId]: next }
        })

    const submit = async () => {
        if (sending) return
        setSending(true)
        setError(null)
        try {
            await send("PUT", "/api/access/admin/users", { email, status, grants })
            onSaved()
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存に失敗しました")
            setSending(false)
        }
    }

    return (
        <Dialog title={user ? "ユーザーを編集" : "ユーザーを追加"} onClose={onClose} onSubmit={() => void submit()}>
            <div className="space-y-1.5">
                <label htmlFor={emailId} className="block text-xs text-muted-foreground">
                    メールアドレス
                </label>
                <input id={emailId} type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={sending || user !== null} required className={INPUT_CLASS} />
            </div>
            <fieldset className="space-y-2">
                <legend className="mb-1 text-xs text-muted-foreground">アプリ別の権限</legend>
                {apps.map((app) => (
                    <div key={app.id} className="rounded-md border border-border p-2">
                        <div className="mb-1 text-xs font-bold">{app.name}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {app.permissions.map((permission) => (
                                <label key={permission} className="flex min-h-8 items-center gap-1.5 text-sm">
                                    <input type="checkbox" checked={grants[app.id]?.includes(permission) ?? false} onChange={() => toggle(app.id, permission)} disabled={sending} className="size-4" />
                                    {permission}
                                </label>
                            ))}
                        </div>
                    </div>
                ))}
            </fieldset>
            {user && (
                <label className="flex min-h-8 items-center gap-2 text-sm">
                    <input type="checkbox" checked={status === "revoked"} onChange={(event) => setStatus(event.target.checked ? "revoked" : "active")} disabled={sending} className="size-4" />
                    <span>
                        このユーザーを取り消す（全アプリで拒否）
                        {isSelf && <span className="text-amber-400">。自分自身です</span>}
                    </span>
                </label>
            )}
            <p className="text-[11px] text-muted-foreground">最後の管理者は取り消せず、StatusHubの管理者権限も外せません。</p>
            <ErrorLine message={error} />
            <Footer sending={sending} onClose={onClose} />
        </Dialog>
    )
}

function AppDialog({ app, onClose, onSaved }: { app: AppState | null; onClose: () => void; onSaved: () => void }) {
    const idId = useId()
    const nameId = useId()
    const customId = useId()
    const [id, setId] = useState(app?.id ?? "")
    const [name, setName] = useState(app?.name ?? "")
    const [permissions, setPermissions] = useState<string[]>(app?.permissions ?? ["viewer"])
    const [customInput, setCustomInput] = useState("")
    const [customError, setCustomError] = useState<string | null>(null)
    const presetValues: readonly string[] = PRESET_PERMISSIONS.map((preset) => preset.value)
    const customPermissions = permissions.filter((permission) => !presetValues.includes(permission))

    const toggle = (permission: string) =>
        setPermissions((current) => (current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]))
    /** 入力欄の値を権限へ足す。足せたら新しい一覧を、足さなかった（空・不正）なら null を返す */
    const addCustom = (): string[] | null => {
        const value = customInput.trim()
        if (!value) return null
        if (!PERMISSION_PATTERN.test(value)) {
            setCustomError("英小文字・数字・_-の1〜30文字で入力してください")
            return null
        }
        const next = permissions.includes(value) ? permissions : [...permissions, value]
        if (next.length > MAX_PERMISSIONS) {
            setCustomError(`権限は${MAX_PERMISSIONS}個までです`)
            return null
        }
        setCustomError(null)
        setCustomInput("")
        setPermissions(next)
        return next
    }
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async () => {
        if (sending) return
        // 「追加」を押し忘れた入力は取り込む。取り込めない値が残っているときは保存しない
        let finalPermissions = permissions
        if (customInput.trim()) {
            const added = addCustom()
            if (!added) return
            finalPermissions = added
        }
        setSending(true)
        setError(null)
        try {
            await send("PUT", "/api/access/admin/apps", {
                id,
                name,
                permissions: finalPermissions,
            })
            onSaved()
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存に失敗しました")
            setSending(false)
        }
    }

    return (
        <Dialog title={app ? "アプリを編集" : "アプリを登録"} onClose={onClose} onSubmit={() => void submit()}>
            <div className="space-y-1.5">
                <label htmlFor={idId} className="block text-xs text-muted-foreground">アプリID（英小文字・数字・ハイフン）</label>
                <input id={idId} value={id} onChange={(event) => setId(event.target.value)} disabled={sending || app !== null} required className={INPUT_CLASS} />
            </div>
            <div className="space-y-1.5">
                <label htmlFor={nameId} className="block text-xs text-muted-foreground">表示名</label>
                <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} disabled={sending} required maxLength={60} className={INPUT_CLASS} />
            </div>
            <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs text-muted-foreground">対応する権限（1つ以上）</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                    {PRESET_PERMISSIONS.map((preset) => (
                        <label key={preset.value} className="flex min-h-11 items-start gap-2 rounded-md border px-3 py-2 has-[:checked]:border-ring has-[:checked]:bg-muted">
                            <input type="checkbox" checked={permissions.includes(preset.value)} onChange={() => toggle(preset.value)} disabled={sending} className="mt-1 size-4" />
                            <span>
                                <span className="block text-sm font-medium">{preset.value}</span>
                                <span className="block text-[11px] text-muted-foreground">{preset.description}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <div className="space-y-1.5">
                <label htmlFor={customId} className="block text-xs text-muted-foreground">その他の権限</label>
                <div className="flex gap-2">
                    <input
                        id={customId}
                        value={customInput}
                        onChange={(event) => setCustomInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault()
                                void addCustom()
                            }
                        }}
                        placeholder="例: reviewer"
                        disabled={sending}
                        className={INPUT_CLASS}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void addCustom()} disabled={sending || !customInput.trim()}>
                        追加
                    </Button>
                </div>
                {customError && <p role="alert" className="text-[11px] text-destructive">{customError}</p>}
                {customPermissions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {customPermissions.map((permission) => (
                            <button
                                key={permission}
                                type="button"
                                onClick={() => toggle(permission)}
                                disabled={sending}
                                aria-label={`${permission}を削除`}
                                className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted"
                            >
                                {permission} ×
                            </button>
                        ))}
                    </div>
                )}
                <p className="text-[11px] text-muted-foreground">権限を減らすと、その権限を持っていたユーザーの付与からも外れます。</p>
            </div>
            <ErrorLine message={error} />
            <Footer sending={sending} onClose={onClose} disabled={permissions.length === 0} />
        </Dialog>
    )
}

function TokenDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
    const [token, setToken] = useState<string | null>(null)
    const [hasToken, setHasToken] = useState(app.hasToken)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [shared, setShared] = useState<{ name: string; written: boolean; reason?: string } | null>(null)

    const issue = async () => {
        setSending(true)
        setError(null)
        try {
            const result = await send("POST", "/api/access/admin/apps/token", { id: app.id })
            setToken(String(result.token))
            setShared((result.sharedToken as typeof shared) ?? null)
            setHasToken(true)
        } catch (e) {
            setError(e instanceof Error ? e.message : "発行に失敗しました")
        }
        setSending(false)
    }
    const revoke = async () => {
        setSending(true)
        setError(null)
        try {
            await send("DELETE", `/api/access/admin/apps/token?id=${encodeURIComponent(app.id)}`)
            setToken(null)
            setShared(null)
            setHasToken(false)
        } catch (e) {
            setError(e instanceof Error ? e.message : "失効に失敗しました")
        }
        setSending(false)
    }

    return (
        <Dialog title={`${app.name}の読み取りトークン`} onClose={onClose} onSubmit={onClose}>
            <p className="text-xs text-muted-foreground">
                このアプリが判定API（POST /api/access/v1/decision）を呼ぶためのトークンです。このアプリの判定だけを読め、設定の変更や他アプリの取得には使えません。
                DBにはハッシュだけを保存するため、平文は発行した直後の1回しか表示できません。
            </p>
            {token ? (
                <div className="space-y-1.5">
                    <code className="block rounded-md border border-border bg-muted/40 p-2 font-mono text-xs [overflow-wrap:anywhere]">{token}</code>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            void navigator.clipboard.writeText(token).then(() => setCopied(true), () => setCopied(false))
                        }}
                    >
                        <Copy aria-hidden />
                        {copied ? "コピーしました" : "コピー"}
                    </Button>
                    {shared?.written ? (
                        <p className="text-[11px] text-muted-foreground">
                            issue-deckの共有トークン <code className="font-mono">{shared.name}</code> へ書き込みました。アプリ側は共有トークンから読めば、最大10分で新しい値になります。
                        </p>
                    ) : (
                        <p className="text-[11px] text-amber-400">
                            共有トークンへ書き込めませんでした{shared?.reason ? `（${shared.reason}）` : ""}。上の値を、issue-deckの設定画面から
                            <code className="font-mono"> {shared?.name ?? "<アプリID>_ACCESS_APP_TOKEN"} </code>として手で登録してください。
                        </p>
                    )}
                    <p className="text-[11px] text-amber-400">この画面を閉じると二度と表示されません。</p>
                </div>
            ) : (
                <>
                    <p className="text-sm">{hasToken ? "発行済みです。再発行すると古いトークンはすぐ使えなくなります。" : "まだ発行されていません。"}</p>
                    {!hasToken && (
                        <p className="text-[11px] text-muted-foreground">失効してもissue-deckの共有トークンの値は消えません（削除APIが無いため）。失効済みの値では判定に通りません。不要なら設定画面から削除してください。</p>
                    )}
                </>
            )}
            <ErrorLine message={error} />
            <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={sending} onClick={() => void issue()}>
                    {hasToken ? "再発行" : "発行"}
                </Button>
                {hasToken && (
                    <Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void revoke()}>
                        失効
                    </Button>
                )}
                <Button type="submit" variant="outline" size="sm" className="ml-auto">閉じる</Button>
            </div>
        </Dialog>
    )
}
