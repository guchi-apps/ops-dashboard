// iPhone の Scriptable アプリ用のウィジェット。このリポジトリのコードからは読み込まれず、
// 端末側に貼り付けて使う。ops-dashboard の /api/claude-usage を参照し、
// Claude の利用枠をロック画面（円形・長方形・インライン）とホーム画面に表示する。
//
// 導入手順:
//   1. Scriptable で新規スクリプトを作り、この内容を貼って保存する
//   2. アプリ内で1回実行し、WIDGET_TOKEN を入力する（Keychain に保存される）
//   3. ロック画面を長押し → ウィジェットを追加 → Scriptable → このスクリプトを選ぶ

const API_URL = "https://admin.gucchii.com/api/claude-usage"
const KEYCHAIN_KEY = "ops-dashboard-widget-token"

// 上流が応答しないときにウィジェットを待たせない。サーバー側も8秒で打ち切っている
const TIMEOUT_SECONDS = 8
const REFRESH_MINUTES = 15

// ネットワークごと失敗したときに備えて端末側にも最後の結果を残す
const CACHE_FILE = "claude-usage-widget.json"

// ---------------------------------------------------------------- トークン

// スクリプト本体に直接書かず Keychain に置く。初回だけアプリ内で実行して登録する
async function getToken() {
    if (Keychain.contains(KEYCHAIN_KEY)) return Keychain.get(KEYCHAIN_KEY)

    if (!config.runsInApp) throw new Error("トークン未登録")

    const alert = new Alert()
    alert.title = "WIDGET_TOKEN を登録"
    alert.message = "ops-dashboard の .env に設定した WIDGET_TOKEN を貼り付けてください。"
    alert.addSecureTextField("token")
    alert.addAction("保存")
    alert.addCancelAction("キャンセル")
    if ((await alert.presentAlert()) === -1) throw new Error("キャンセルしました")

    const token = alert.textFieldValue(0).trim()
    if (!token) throw new Error("トークンが空です")
    Keychain.set(KEYCHAIN_KEY, token)
    return token
}

// ---------------------------------------------------------------- 取得

const fm = FileManager.local()
const cachePath = fm.joinPath(fm.cacheDirectory(), CACHE_FILE)

function readCache() {
    try {
        return JSON.parse(fm.readString(cachePath))
    } catch {
        return null
    }
}

async function fetchUsage() {
    const req = new Request(API_URL)
    req.headers = { Authorization: `Bearer ${await getToken()}` }
    req.timeoutInterval = TIMEOUT_SECONDS

    const data = await req.loadJSON()
    if (req.response.statusCode !== 200) {
        throw new Error(data?.error ?? `HTTP ${req.response.statusCode}`)
    }

    fm.writeString(cachePath, JSON.stringify(data))
    return data
}

// サーバー側の stale フォールバックが効かない（圏外・VPS停止）場合の最後の砦
async function loadUsage() {
    try {
        return await fetchUsage()
    } catch (error) {
        const cached = readCache()
        if (cached) return { ...cached, stale: true }
        throw error
    }
}

// ---------------------------------------------------------------- 整形

// サーバーは上流のJSONを素通しするため、キーが欠けていても落ちないようにする。
// utilization は 0〜1 ではなく 0〜100（パーセント）で返る
function toWindow(source) {
    if (!source || typeof source.utilization !== "number") return null
    return {
        percent: Math.min(100, Math.max(0, source.utilization)),
        resetsAt: source.resets_at ? new Date(source.resets_at) : null,
    }
}

/** リセットまでの残り時間を "3h20m" / "2d" のように縮める */
function formatRemaining(resetsAt) {
    if (!resetsAt || Number.isNaN(resetsAt.getTime())) return ""

    const minutes = Math.round((resetsAt.getTime() - Date.now()) / 60000)
    if (minutes <= 0) return "0m"
    if (minutes < 60) return `${minutes}m`

    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
        const rest = minutes % 60
        return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
    }
    return `${Math.floor(hours / 24)}d`
}

// ---------------------------------------------------------------- 描画部品

// ロック画面のアクセサリはシステム側で単色化されるため、色ではなく濃淡で差をつける
function gaugeImage(percent, label) {
    const size = 200
    const lineWidth = 18
    const radius = size / 2 - lineWidth / 2
    const center = new Point(size / 2, size / 2)

    const ctx = new DrawContext()
    ctx.size = new Size(size, size)
    ctx.opaque = false
    ctx.respectScreenScale = true

    const arc = (from, to, alpha) => {
        const path = new Path()
        const steps = 120
        for (let i = 0; i <= steps; i++) {
            const angle = from + (to - from) * (i / steps)
            const point = new Point(
                center.x + radius * Math.cos(angle),
                center.y + radius * Math.sin(angle)
            )
            if (i === 0) path.move(point)
            else path.addLine(point)
        }
        ctx.setStrokeColor(new Color("#ffffff", alpha))
        ctx.setLineWidth(lineWidth)
        ctx.addPath(path)
        ctx.strokePath()
    }

    const start = -Math.PI / 2
    arc(start, start + Math.PI * 2, 0.25)
    if (percent > 0) arc(start, start + Math.PI * 2 * (percent / 100), 1)

    ctx.setTextAlignedCenter()
    ctx.setTextColor(Color.white())
    ctx.setFont(Font.boldSystemFont(58))
    ctx.drawTextInRect(`${Math.round(percent)}`, new Rect(0, 58, size, 66))
    ctx.setFont(Font.mediumSystemFont(28))
    ctx.drawTextInRect(label, new Rect(0, 122, size, 34))

    return ctx.getImage()
}

/** 長方形ウィジェットの1行分（枠の名前・使用率のバー・残り時間） */
function addBar(stack, label, window, trackWidth) {
    const row = stack.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    row.spacing = 5

    const name = row.addText(label)
    name.font = Font.mediumSystemFont(11)
    name.textOpacity = 0.7
    name.lineLimit = 1

    // Scriptable には割合指定が無いため、実寸を計算して塗り分ける
    const track = row.addStack()
    track.layoutHorizontally()
    track.size = new Size(trackWidth, 8)
    track.cornerRadius = 4
    track.backgroundColor = new Color("#ffffff", 0.25)

    const filled = track.addStack()
    filled.size = new Size(Math.max(2, (trackWidth * window.percent) / 100), 8)
    filled.cornerRadius = 4
    filled.backgroundColor = Color.white()
    track.addSpacer()

    const value = row.addText(`${Math.round(window.percent)}%`)
    value.font = Font.boldSystemFont(11)

    const remaining = formatRemaining(window.resetsAt)
    if (remaining) {
        const reset = row.addText(remaining)
        reset.font = Font.systemFont(10)
        reset.textOpacity = 0.6
    }
}

// ---------------------------------------------------------------- ウィジェット

function buildWidget(usage) {
    const fiveHour = toWindow(usage.five_hour)
    const sevenDay = toWindow(usage.seven_day)
    // サーバーが古いキャッシュを返している（または端末側キャッシュに退避した）ときの目印
    const marker = usage.stale ? "＊" : ""

    const widget = new ListWidget()
    widget.addAccessoryWidgetBackground = true
    widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000)

    switch (config.widgetFamily) {
        case "accessoryInline": {
            const parts = []
            if (fiveHour) parts.push(`5h ${Math.round(fiveHour.percent)}%`)
            if (sevenDay) parts.push(`7d ${Math.round(sevenDay.percent)}%`)
            widget.addText(`${marker}${parts.join(" / ") || "取得不可"}`)
            return widget
        }

        case "accessoryCircular": {
            // 円形は1つしか置けないため、動きの速い5時間枠を優先する
            const target = fiveHour ?? sevenDay
            if (!target) {
                widget.addText("—")
                return widget
            }
            widget.addImage(gaugeImage(target.percent, fiveHour ? "5h" : "7d"))
            return widget
        }

        default: {
            widget.setPadding(4, 6, 4, 6)
            const title = widget.addText(`Claude${marker}`)
            title.font = Font.semiboldSystemFont(12)
            widget.addSpacer(3)

            if (!fiveHour && !sevenDay) {
                widget.addText("利用枠を取得できません").font = Font.systemFont(11)
                return widget
            }

            // ロック画面の長方形は横幅が狭いので、ホーム画面より短いバーにする
            const trackWidth = config.widgetFamily === "accessoryRectangular" ? 56 : 80
            if (fiveHour) addBar(widget, "5h", fiveHour, trackWidth)
            if (fiveHour && sevenDay) widget.addSpacer(3)
            if (sevenDay) addBar(widget, "7d", sevenDay, trackWidth)
            return widget
        }
    }
}

function errorWidget(message) {
    const widget = new ListWidget()
    widget.addAccessoryWidgetBackground = true
    // 失敗時は次の更新までの間隔を詰める
    widget.refreshAfterDate = new Date(Date.now() + 5 * 60000)

    const text = widget.addText(config.widgetFamily === "accessoryCircular" ? "!" : message)
    text.font = Font.systemFont(11)
    text.minimumScaleFactor = 0.7
    return widget
}

// ---------------------------------------------------------------- 実行

let widget
try {
    widget = buildWidget(await loadUsage())
} catch (error) {
    widget = errorWidget(`Claude: ${error.message}`)
}

if (config.runsInWidget) {
    Script.setWidget(widget)
} else if (config.widgetFamily === "accessoryCircular") {
    widget.presentAccessoryCircular()
} else if (config.widgetFamily === "accessoryInline") {
    widget.presentAccessoryInline()
} else {
    widget.presentAccessoryRectangular()
}
Script.complete()
