import fs from "fs/promises"
import path from "path"
import webpush, { type PushSubscription } from "web-push"

/**
 * AI利用枠の通知（#263）を端末へ届けるWeb Push。
 *
 * 画面を閉じていても届けるため、判定はサーバー側（使用状況を取得するたび）で行い、
 * ブラウザが発行した購読（エンドポイントと暗号鍵）へ送る。購読は `.data/` にファイルで持つ。
 * 鍵が未設定なら機能ごと無効で、画面にも通知ボタンを出さない。
 */

/**
 * VAPIDの連絡先。プッシュサービスが送信元へ連絡するためのもので、`mailto:` か `https:` で書く。
 * 個人のメールアドレスをリポジトリへ置かないよう、リポジトリのURLを既定にしている。
 */
const DEFAULT_SUBJECT = "https://github.com/guchi-apps/status-hub"

/** 端末がオフラインのときにプッシュサービスが保持する時間。枠の通知は数時間で意味を失う */
const PUSH_TTL_SECONDS = 60 * 60

/**
 * 配信の優先度。既定（normal）だと、iPhoneでは省電力のために配信が後回しにされることがある。
 * 利用枠の通知はリセットまでの数時間で意味を失うため、すぐ届けてもらう（#297）
 */
const PUSH_URGENCY = "high"

/** 応答しないプッシュサービスに、定期判定（#495）が詰まらないよう待つ上限 */
const PUSH_TIMEOUT_MS = 10_000

export interface PushMessage {
    title: string
    body: string
    /** 同じtagの通知は端末上で置き換わる。枠ごとに付け、90%の通知を100%の通知で差し替える */
    tag?: string
    /** 通知をタップしたときに開くパス */
    url?: string
    /**
     * PWAアイコンに出す未解消エラー件数と、その通番（#495）。どちらもあるときだけService Workerが
     * 反映する（AI利用枠の通知は持たない）。通番が保存済みより古いPushでは件数を巻き戻さない
     */
    badge?: number
    seq?: number
}

/** 送信1回ぶんの結果 */
export interface PushSendResult {
    /** 届いた（プッシュサービスが受け付けた）端末の数 */
    delivered: number
    /** 404・410が返り、無効として消した購読の数 */
    removed: number
    /** それ以外で失敗したときのステータスコード（通信エラーなどコードが無いものは "error"） */
    failures: (number | "error")[]
}

export const LOGIN_ALERTS_MODES = ["always", "new", "off"] as const
export type LoginAlertsMode = (typeof LOGIN_ALERTS_MODES)[number]

export function isLoginAlertsMode(value: unknown): value is LoginAlertsMode {
    return typeof value === "string" && (LOGIN_ALERTS_MODES as readonly string[]).includes(value)
}

export interface StoredSubscription extends PushSubscription {
    /** 登録したログイン利用者のメール（#495）。記録が無い古い購読は、次の登録し直しで紐づく */
    email?: string
    /** ホスト停止・監視異常の通知を受けるか。未設定はオン。端末ごとに切り替える */
    hostAlerts?: boolean
    /** ログイン通知（#516）。未設定は毎回。管理者の端末にだけ送る */
    loginAlerts?: LoginAlertsMode
    /** 初めて登録した日時。同じ端末の登録し直しでは変えない（購読が入れ替わったかを見分けるため。#297） */
    createdAt: string
    /** 最後に端末から登録し直された日時。アプリを開くたびに更新される */
    lastSeenAt?: string
}

interface SubscriptionState {
    subscriptions: StoredSubscription[]
}

export function getVapidPublicKey(): string | null {
    return process.env.WEB_PUSH_VAPID_PUBLIC_KEY || null
}

function getVapidDetails() {
    const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
    const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
    if (!publicKey || !privateKey) return null

    return { subject: process.env.WEB_PUSH_SUBJECT || DEFAULT_SUBJECT, publicKey, privateKey }
}

export function isWebPushConfigured(): boolean {
    return getVapidDetails() !== null
}

function getStatePath(): string {
    return (
        process.env.PUSH_SUBSCRIPTIONS_PATH ||
        path.join(process.cwd(), ".data", "push-subscriptions.json")
    )
}

async function readState(): Promise<SubscriptionState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(), "utf8"))
        const subscriptions = (parsed as SubscriptionState | null)?.subscriptions
        return { subscriptions: Array.isArray(subscriptions) ? subscriptions : [] }
    } catch {
        return { subscriptions: [] }
    }
}

async function writeState(state: SubscriptionState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/** ファイルへの read-modify-write を直列化する（PM2は1プロセスで動かしている） */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/** ブラウザから受け取った値が購読の形をしているか。保存する前に必ず通す */
export function isPushSubscription(value: unknown): value is PushSubscription {
    if (!value || typeof value !== "object") return false

    const { endpoint, keys } = value as Record<string, unknown>
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return false
    if (!keys || typeof keys !== "object") return false

    const { p256dh, auth } = keys as Record<string, unknown>
    return typeof p256dh === "string" && typeof auth === "string"
}

/**
 * 購読を登録する。同じ端末（エンドポイント）はすでにあれば鍵だけ置き換える。
 *
 * 起動のたびに登録し直されるため、端末ごとの設定（`hostAlerts`）は既存の記録から引き継ぐ。
 * 利用者はログインセッションのメールで毎回付け直す。`hostAlerts` は渡されたときだけ変える
 */
export function saveSubscription(
    subscription: PushSubscription,
    owner?: { email: string; hostAlerts?: boolean; loginAlerts?: LoginAlertsMode }
): Promise<void> {
    return serialize(async () => {
        const state = await readState()
        const existing = state.subscriptions.find((item) => item.endpoint === subscription.endpoint)
        const others = state.subscriptions.filter((item) => item.endpoint !== subscription.endpoint)
        const now = new Date().toISOString()
        others.push({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
            createdAt: existing?.createdAt ?? now,
            lastSeenAt: now,
            ...((owner?.email ?? existing?.email) && { email: owner?.email ?? existing?.email }),
            ...((owner?.hostAlerts ?? existing?.hostAlerts) !== undefined && {
                hostAlerts: owner?.hostAlerts ?? existing?.hostAlerts,
            }),
            ...((owner?.loginAlerts ?? existing?.loginAlerts) !== undefined && {
                loginAlerts: owner?.loginAlerts ?? existing?.loginAlerts,
            }),
        })
        await writeState({ subscriptions: others })
    })
}

export function removeSubscriptions(endpoints: string[]): Promise<void> {
    if (endpoints.length === 0) return Promise.resolve()

    return serialize(async () => {
        const state = await readState()
        const remaining = state.subscriptions.filter((item) => !endpoints.includes(item.endpoint))
        if (remaining.length !== state.subscriptions.length) {
            await writeState({ subscriptions: remaining })
        }
    })
}

/**
 * 端末の購読を、その持ち主のときだけ消す。持ち主が記録されていない古い購読は、
 * ログイン済みの利用者なら消せる（記録が無く、照合できないため）
 */
export function removeSubscriptionOf(
    endpoint: string,
    email: string
): Promise<"removed" | "missing" | "forbidden"> {
    return serialize(async () => {
        const state = await readState()
        const target = state.subscriptions.find((item) => item.endpoint === endpoint)
        if (!target) return "missing"
        if (target.email && target.email !== email) return "forbidden"
        await writeState({ subscriptions: state.subscriptions.filter((item) => item !== target) })
        return "removed"
    })
}

export async function listSubscriptions(): Promise<StoredSubscription[]> {
    return (await readState()).subscriptions
}

export async function hasSubscriptions(): Promise<boolean> {
    return (await readState()).subscriptions.length > 0
}

/**
 * 購読へ送る。届いた件数と、届かなかった理由を返す。
 *
 * 404・410はプッシュサービスが「この購読はもう無い」と返したもの（アプリの削除・通知の取り消し）なので、
 * 記録から消す。それ以外の失敗は一時的なものとして残す。
 */
async function sendTo(subscriptions: PushSubscription[], message: PushMessage): Promise<PushSendResult> {
    const vapidDetails = getVapidDetails()
    if (!vapidDetails || subscriptions.length === 0) return { delivered: 0, removed: 0, failures: [] }

    const payload = JSON.stringify(message)
    const gone: string[] = []
    const failures: PushSendResult["failures"] = []

    const results = await Promise.all(
        subscriptions.map(async (subscription) => {
            try {
                await webpush.sendNotification(subscription, payload, {
                    vapidDetails,
                    TTL: PUSH_TTL_SECONDS,
                    urgency: PUSH_URGENCY,
                    timeout: PUSH_TIMEOUT_MS,
                })
                return true
            } catch (error) {
                const statusCode = (error as { statusCode?: number }).statusCode
                if (statusCode === 404 || statusCode === 410) {
                    gone.push(subscription.endpoint)
                } else {
                    failures.push(statusCode ?? "error")
                    console.error("[web-push] 通知の送信に失敗しました:", statusCode ?? error)
                }
                return false
            }
        })
    )

    // 404・410で消した購読は、届かなかった理由として残す（以前は黙って消していた。#297）。
    // エンドポイントには端末ごとの識別子が入るため、ホスト名だけを出す
    if (gone.length > 0) {
        const hosts = gone.map((endpoint) => new URL(endpoint).host).join(", ")
        console.warn(`[web-push] 無効になった購読を${gone.length}件削除しました: ${hosts}`)
    }
    await removeSubscriptions(gone)
    return { delivered: results.filter(Boolean).length, removed: gone.length, failures }
}

/** 登録済みの全端末へ送る */
export async function sendPushToAll(message: PushMessage): Promise<PushSendResult> {
    return sendTo((await readState()).subscriptions, message)
}

/** 条件に合う購読だけへ送る（ホスト通知を、いまアクセスが許可されている利用者の端末に絞る。#495） */
export async function sendPushWhere(
    predicate: (subscription: StoredSubscription) => boolean,
    message: PushMessage
): Promise<PushSendResult> {
    return sendTo((await readState()).subscriptions.filter(predicate), message)
}

/** 1台だけへ送る（通知をオンにした直後の確認用） */
export async function sendPushTo(subscription: PushSubscription, message: PushMessage): Promise<boolean> {
    return (await sendTo([subscription], message)).delivered > 0
}
