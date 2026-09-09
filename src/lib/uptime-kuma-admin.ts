import { io, type Socket } from "socket.io-client"

/**
 * Uptime Kuma へモニターを登録する経路。
 *
 * **Uptime Kuma にはモニターを作るREST APIが無い**（1.x・2.x とも）。作成できるのは
 * ログイン済みの socket.io セッションから `add` イベントを送る経路だけで、公開されている
 * `/api/status-page/*` は読み取り専用である（v1.23.17 の `server/server.js:643`）。
 * そのため、ここだけは公式に約束された仕様ではなく、画面が使っている内部プロトコルを
 * そのまま利用している。Kumaの更新で壊れうることを前提に、失敗しても呼び出し側が
 * 「Kumaの画面で手で追加する」へ倒せる形（例外を投げるだけ）にしてある。
 *
 * **`add` だけではダッシュボードに出ない。** この画面は公開ステータスページ
 * （`/api/status-page/<slug>`）を読んでいるため、作成したモニターをそのページへ
 * 載せるところまでやって初めて一覧に並ぶ。
 */

/** 接続の待ち時間。Render無料プランはスリープからの復帰があるため長めに取る */
const CONNECT_TIMEOUT_MS = 30_000

/** socketイベントの応答待ち */
const ACK_TIMEOUT_MS = 20_000

/** ログイン後にサーバーが押し込んでくる通知一覧の待ち時間 */
const NOTIFICATION_LIST_TIMEOUT_MS = 10_000

/**
 * Kuma の画面が新規モニターに使う既定値（v1.23.17 の `src/pages/EditMonitor.vue` の
 * `monitorDefaults`）をそのまま写したもの。
 *
 * サーバー側の `add` は受け取ったオブジェクトを RedBean の bean へ丸ごと import する
 * だけで、既定値の補完をしない。画面が送るのと同じ形にしておかないと、列が空のまま
 * 保存されて監視が正しく動かない。
 */
const MONITOR_DEFAULTS = {
    type: "http",
    name: "",
    parent: null,
    url: "https://",
    method: "GET",
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 0,
    timeout: 48,
    ignoreTls: false,
    upsideDown: false,
    packetSize: 56,
    expiryNotification: false,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    dns_resolve_type: "A",
    dns_resolve_server: "1.1.1.1",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttSuccessMessage: "",
    authMethod: null,
    oauth_auth_method: "client_secret_basic",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
}

/** ステータスページにグループが1つも無かったときに作るグループ名 */
const DEFAULT_GROUP_NAME = "Services"

export interface AddUptimeKumaMonitorInput {
    name: string
    url: string
    /** 監視間隔（秒）。未指定なら60 */
    interval?: number
    /** ダウン判定までの再試行回数。未指定なら0 */
    retries?: number
}

export interface AddUptimeKumaMonitorResult {
    monitorId: number
    /** 新しく作ったなら true。同じURLのモニターが既にあって流用したなら false */
    created: boolean
    /** ダッシュボードが読むステータスページに載っているなら true */
    onStatusPage: boolean
}

/** Kumaとのやり取りで想定内の失敗（設定不足・認証失敗・重複など）を表す */
export class UptimeKumaAdminError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UptimeKumaAdminError"
    }
}

interface AdminConfig {
    baseUrl: string
    username: string
    password: string
    /** ダッシュボードが読むステータスページのslug。未設定なら作成のみ行う */
    slug: string | undefined
}

function readAdminConfig(): AdminConfig | null {
    const baseUrl = process.env.UPTIMEKUMA_BASE_URL?.replace(/\/+$/, "")
    const username = process.env.UPTIMEKUMA_USERNAME
    const password = process.env.UPTIMEKUMA_PASSWORD

    if (!baseUrl || !username || !password) return null

    return { baseUrl, username, password, slug: process.env.UPTIMEKUMA_DASHBOARD_SLUG }
}

/** 管理者としての登録が使えるか。使えないときは画面側でKumaを開くリンクへ倒す */
export function isUptimeKumaAdminConfigured(): boolean {
    return readAdminConfig() !== null
}

/** ログイン後にサーバーが押し込んでくるモニター一覧。IDをキーにしたオブジェクトで届く */
type KumaMonitorList = Record<string, { id: number; name: string; url?: string | null }>

interface KumaNotification {
    id: number
    isDefault?: boolean
}

interface KumaStatusPageConfig {
    slug: string
    icon: string
    [key: string]: unknown
}

/** 公開ステータスページのグループ。`saveStatusPage` へそのまま返せる形で持つ */
interface KumaPublicGroup {
    id?: number
    name: string
    monitorList: { id: number; name: string; sendUrl?: number; type?: string; url?: string }[]
}

/**
 * モニターを1件登録し、ダッシュボードのステータスページへ載せる。
 *
 * 同じURLのモニターが既にあれば作らずにそれを使う（アプリ作成の手順から何度呼んでも
 * 重複が増えないようにするため）。
 */
export async function addUptimeKumaMonitor(
    input: AddUptimeKumaMonitorInput
): Promise<AddUptimeKumaMonitorResult> {
    const config = readAdminConfig()
    if (!config) {
        throw new UptimeKumaAdminError(
            "Uptime Kuma の管理者認証情報（UPTIMEKUMA_USERNAME / UPTIMEKUMA_PASSWORD）が設定されていません"
        )
    }

    const name = input.name.trim()
    const url = input.url.trim()

    if (!name) throw new UptimeKumaAdminError("名前を入力してください")
    if (!isHttpUrl(url)) {
        throw new UptimeKumaAdminError("URLは http:// または https:// で始まる必要があります")
    }

    const interval = input.interval ?? MONITOR_DEFAULTS.interval
    if (!Number.isInteger(interval) || interval < 20 || interval > 86400) {
        throw new UptimeKumaAdminError("監視間隔は20〜86400秒で指定してください")
    }

    const retries = input.retries ?? MONITOR_DEFAULTS.maxretries
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new UptimeKumaAdminError("再試行回数は0〜10で指定してください")
    }

    const socket = io(config.baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        timeout: CONNECT_TIMEOUT_MS,
    })

    // ログインするとサーバーが一覧を押し込んでくる。要求と応答の対になっていないため、
    // 届いたものをここで受けておき、必要になった時点で読む
    let monitorList: KumaMonitorList = {}
    let notifications: KumaNotification[] | null = null
    socket.on("monitorList", (list: KumaMonitorList) => {
        monitorList = list ?? {}
    })
    socket.on("notificationList", (list: KumaNotification[]) => {
        notifications = list ?? []
    })

    try {
        await waitForConnect(socket)
        await login(socket, config)

        // ackが返る時点で `monitorList` の押し込みは済んでいる
        await emitWithAck(socket, "getMonitorList")

        const existing = findMonitorByUrl(monitorList, url)
        if (existing) {
            const onStatusPage = await ensureOnStatusPage(socket, config, {
                id: existing.id,
                name: existing.name,
                url,
            })
            return { monitorId: existing.id, created: false, onStatusPage }
        }

        await waitFor(() => notifications !== null, NOTIFICATION_LIST_TIMEOUT_MS)
        if (notifications === null) {
            console.warn("Uptime Kuma: 通知一覧が届かなかったため、通知を紐づけずに作成します")
        }

        const result = await emitWithAck<{ monitorID?: number }>(socket, "add", {
            ...MONITOR_DEFAULTS,
            name,
            url,
            interval,
            // 画面では再試行の間隔が監視間隔に追従する。同じ挙動に合わせる
            retryInterval: interval,
            maxretries: retries,
            notificationIDList: defaultNotificationIdList(notifications ?? []),
        })

        const monitorId = result.monitorID
        if (typeof monitorId !== "number") {
            throw new UptimeKumaAdminError("Uptime Kuma がモニターIDを返しませんでした")
        }

        const onStatusPage = await ensureOnStatusPage(socket, config, { id: monitorId, name, url })
        return { monitorId, created: true, onStatusPage }
    } finally {
        socket.disconnect()
    }
}

/**
 * 作成したモニターを、ダッシュボードが読む公開ステータスページへ載せる。
 *
 * `saveStatusPage` はグループとモニターの割り当てを**丸ごと置き換える**（送らなかった
 * グループは消える）。そのため、いま公開されている内容をそのまま読み直し、末尾に1件
 * 足したものを送り返す形にしている。設定本体も `getStatusPage` で取ったものをそのまま
 * 返す（公開APIの設定にはドメイン一覧が含まれず、そちらを使うと設定が消えるため）。
 */
async function ensureOnStatusPage(
    socket: Socket,
    config: AdminConfig,
    monitor: { id: number; name: string; url: string }
): Promise<boolean> {
    if (!config.slug) return false

    const groups = await fetchPublicGroupList(config.baseUrl, config.slug)
    if (groups.some((group) => group.monitorList.some((m) => m.id === monitor.id))) {
        return true
    }

    const page = await emitWithAck<{ config?: KumaStatusPageConfig }>(
        socket,
        "getStatusPage",
        config.slug
    )
    if (!page.config) {
        throw new UptimeKumaAdminError("ステータスページの設定を取得できませんでした")
    }

    const target = groups[0] ?? { name: DEFAULT_GROUP_NAME, monitorList: [] }
    const nextGroups = groups.length > 0 ? groups : [target]
    target.monitorList.push({
        id: monitor.id,
        name: monitor.name,
        // 1 でURLをステータスページに出す。既存のモニターに合わせている
        sendUrl: 1,
        type: "http",
        url: monitor.url,
    })

    await emitWithAck(
        socket,
        "saveStatusPage",
        config.slug,
        page.config,
        // 画面と同じく、いまのアイコンをそのまま送り返す（data URLでなければ変更されない）
        page.config.icon,
        nextGroups
    )

    return true
}

/** 公開ステータスページの現在の内容。`saveStatusPage` へ返せる形で取り出す */
async function fetchPublicGroupList(baseUrl: string, slug: string): Promise<KumaPublicGroup[]> {
    const res = await fetch(`${baseUrl}/api/status-page/${slug}`, { cache: "no-store" })
    if (!res.ok) {
        throw new UptimeKumaAdminError(
            `ステータスページ（${slug}）を取得できませんでした: ${res.status}`
        )
    }

    const page = (await res.json()) as { publicGroupList?: KumaPublicGroup[] }
    return page.publicGroupList ?? []
}

async function login(socket: Socket, config: AdminConfig): Promise<void> {
    // 2要素認証が有効なアカウントの応答は `{ tokenRequired: true }` で `ok` を持たない
    // （v1.23.17 の `server/server.js:377`）。`ok` を見る前にこちらを判定する必要があるため、
    // ここだけは応答をそのまま受け取る
    const result = await emitRaw<{ ok?: boolean; msg?: string; tokenRequired?: boolean }>(
        socket,
        "login",
        { username: config.username, password: config.password, token: "" }
    )

    if (result?.tokenRequired) {
        throw new UptimeKumaAdminError(
            "Uptime Kuma の管理者アカウントで2要素認証が有効なため、自動登録できません"
        )
    }
    if (!result?.ok) {
        throw new UptimeKumaAdminError(
            `Uptime Kuma へログインできませんでした: ${result?.msg ?? "原因不明"}`
        )
    }
}

/** 既定の通知先を、Kumaが期待する `{ 通知ID: true }` の形にする */
function defaultNotificationIdList(notifications: KumaNotification[]): Record<number, boolean> {
    const list: Record<number, boolean> = {}
    for (const notification of notifications) {
        if (notification.isDefault) list[notification.id] = true
    }
    return list
}

function findMonitorByUrl(
    monitorList: KumaMonitorList,
    url: string
): { id: number; name: string } | null {
    const target = normalizeUrl(url)

    for (const monitor of Object.values(monitorList)) {
        if (monitor.url && normalizeUrl(monitor.url) === target) {
            return { id: monitor.id, name: monitor.name }
        }
    }

    return null
}

/** 末尾スラッシュの有無だけが違うURLを同じものとして扱う */
function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url)
        const path = parsed.pathname.replace(/\/+$/, "")
        return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`
    } catch {
        return url
    }
}

function isHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
        return false
    }
}

function waitForConnect(socket: Socket): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup()
            reject(new UptimeKumaAdminError("Uptime Kuma へ接続できませんでした（タイムアウト）"))
        }, CONNECT_TIMEOUT_MS)

        const cleanup = () => {
            clearTimeout(timeoutId)
            socket.off("connect", onConnect)
            socket.off("connect_error", onError)
        }
        const onConnect = () => {
            cleanup()
            resolve()
        }
        const onError = (error: Error) => {
            cleanup()
            reject(new UptimeKumaAdminError(`Uptime Kuma へ接続できませんでした: ${error.message}`))
        }

        socket.once("connect", onConnect)
        socket.once("connect_error", onError)
    })
}

/**
 * `{ ok, msg }` を返すKumaのイベントを送り、応答を待つ。
 *
 * Kumaは失敗もHTTPのステータスではなく応答の `ok` で返してくるため、ここで例外へ揃える。
 */
async function emitWithAck<T = Record<string, unknown>>(
    socket: Socket,
    event: string,
    ...args: unknown[]
): Promise<T & { ok?: boolean; msg?: string }> {
    const response = await emitRaw<T & { ok?: boolean; msg?: string }>(socket, event, ...args)

    if (!response?.ok) {
        throw new UptimeKumaAdminError(response?.msg ?? `Uptime Kuma が ${event} を拒否しました`)
    }

    return response
}

/** 応答の中身を判定せずに受け取る。`ok` を持たない応答（ログインの2要素認証）用 */
function emitRaw<T>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
        socket
            .timeout(ACK_TIMEOUT_MS)
            .emit(event, ...args, (error: Error | null, response: T) => {
                if (error) {
                    reject(new UptimeKumaAdminError(`Uptime Kuma が応答しませんでした（${event}）`))
                    return
                }
                resolve(response)
            })
    })
}

/** 押し込みで届くデータを待つ。時間切れになっても例外にはしない（呼び出し側で判断する） */
async function waitFor(isReady: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (!isReady() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}
