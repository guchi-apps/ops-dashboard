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
const DEFAULT_SUBJECT = "https://github.com/guchi-apps/ops-dashboard"

/** 端末がオフラインのときにプッシュサービスが保持する時間。枠の通知は数時間で意味を失う */
const PUSH_TTL_SECONDS = 60 * 60

export interface PushMessage {
    title: string
    body: string
    /** 同じtagの通知は端末上で置き換わる。枠ごとに付け、90%の通知を100%の通知で差し替える */
    tag?: string
    /** 通知をタップしたときに開くパス */
    url?: string
}

interface StoredSubscription extends PushSubscription {
    createdAt: string
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

/** 購読を登録する。同じ端末（エンドポイント）はすでにあれば鍵だけ置き換える */
export function saveSubscription(subscription: PushSubscription): Promise<void> {
    return serialize(async () => {
        const state = await readState()
        const others = state.subscriptions.filter((item) => item.endpoint !== subscription.endpoint)
        others.push({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
            createdAt: new Date().toISOString(),
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

export async function hasSubscriptions(): Promise<boolean> {
    return (await readState()).subscriptions.length > 0
}

/**
 * 購読へ送る。届いた件数を返す。
 *
 * 404・410はプッシュサービスが「この購読はもう無い」と返したもの（アプリの削除・通知の取り消し）なので、
 * 記録から消す。それ以外の失敗は一時的なものとして残す。
 */
async function sendTo(subscriptions: PushSubscription[], message: PushMessage): Promise<number> {
    const vapidDetails = getVapidDetails()
    if (!vapidDetails || subscriptions.length === 0) return 0

    const payload = JSON.stringify(message)
    const gone: string[] = []

    const results = await Promise.all(
        subscriptions.map(async (subscription) => {
            try {
                await webpush.sendNotification(subscription, payload, {
                    vapidDetails,
                    TTL: PUSH_TTL_SECONDS,
                })
                return true
            } catch (error) {
                const statusCode = (error as { statusCode?: number }).statusCode
                if (statusCode === 404 || statusCode === 410) {
                    gone.push(subscription.endpoint)
                } else {
                    console.error("[web-push] 通知の送信に失敗しました:", statusCode ?? error)
                }
                return false
            }
        })
    )

    await removeSubscriptions(gone)
    return results.filter(Boolean).length
}

/** 登録済みの全端末へ送る */
export async function sendPushToAll(message: PushMessage): Promise<number> {
    return sendTo((await readState()).subscriptions, message)
}

/** 1台だけへ送る（通知をオンにした直後の確認用） */
export async function sendPushTo(subscription: PushSubscription, message: PushMessage): Promise<boolean> {
    return (await sendTo([subscription], message)) > 0
}
