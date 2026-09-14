import { AIDE_SEVERITY_LABEL, formatAideDuration } from "@/lib/aide-status-format"
import { formatAge } from "@/lib/host-stats/format"
import { summarizeTimers } from "@/lib/host-stats/timers"
import { summarizeTmux, type TmuxSessionView } from "@/lib/host-stats/tmux"
import type { UptimeKumaMonitor } from "@/lib/uptime-kuma"
import type { UptimeRobotMonitor } from "@/lib/uptimerobot"
import type { AiProviderId, AiUsageSnapshot } from "@/types/ai-usage"
import type { AideStatusSnapshot } from "@/types/aide-status"
import type { GitHubUsageSnapshot } from "@/types/github-usage"
import type { HostStatsView } from "@/types/host-stats"
import type { OnePasswordUsageSnapshot } from "@/types/onepassword-usage"

export type SummaryTone = "ok" | "warn" | "danger" | "neutral"

/** チップ値の一部分。ラベル語など数字より控えめに出したい部分は muted を立てる */
export interface SummaryChipValuePart {
    text: string
    muted?: boolean
}

/** 画面上部に常時出す集約チップ1枚分 */
export interface SummaryChip {
    key: string
    label: string
    value: string
    /** value を強弱付きで描画したいときに指定する。無ければ value をそのまま出す */
    valueParts?: SummaryChipValuePart[]
    /** 値の下に添える一言。何が起きているかを1行で言い切る */
    note?: string
    tone: SummaryTone
}

/** 残量（%）の色分け。AI・GitHub・1Passwordで同じ基準を使う */
function remainingTone(remainingPercent: number): SummaryTone {
    if (remainingPercent <= 15) return "danger"
    if (remainingPercent <= 35) return "warn"
    return "ok"
}

function hostChip(view: HostStatsView | null): SummaryChip | null {
    if (!view?.hosts.length) return null

    const online = view.hosts.filter((host) => host.online)
    const offline = view.hosts.filter((host) => !host.online)
    const newestAge = Math.min(...view.hosts.map((host) => host.ageSeconds))

    return {
        key: "hosts",
        label: "ホスト",
        value: `${online.length} / ${view.hosts.length} online`,
        note:
            offline.length > 0
                ? `${offline.map((host) => host.label).join("・")} が応答なし`
                : `最終受信 ${formatAge(newestAge)}`,
        tone: offline.length > 0 ? "danger" : "ok",
    }
}

function monitorChip(kuma: UptimeKumaMonitor[], robot: UptimeRobotMonitor[]): SummaryChip | null {
    const total = kuma.length + robot.length
    if (total === 0) return null

    const downNames = [
        ...kuma.filter((monitor) => monitor.status === "down").map((monitor) => monitor.name),
        // UptimeRobot の 8（応答なし）・9（停止）を停止として数える
        ...robot.filter((monitor) => monitor.status >= 8).map((monitor) => monitor.friendly_name),
    ]
    const pending = kuma.filter((monitor) => monitor.status === "pending").length

    return {
        key: "monitors",
        label: "監視",
        value: `${total - downNames.length} / ${total} Up`,
        note:
            downNames.length > 0
                ? `${downNames.join("・")} が Down`
                : pending > 0
                  ? `${pending}件が確認中`
                  : "すべて正常",
        tone: downNames.length > 0 ? "danger" : pending > 0 ? "warn" : "ok",
    }
}

function tmuxChip(view: HostStatsView | null, sessions: TmuxSessionView[]): SummaryChip | null {
    const summary = summarizeTmux(view?.hosts ?? [], sessions)
    if (!summary.available) return null

    // 一覧に載らなかった分がある＝いま見えているものが全てではない。放置の件数より先に知らせる
    const notes: string[] = []
    if (summary.untracked > 0) notes.push(`送信上限で ${summary.untracked}件 未取得`)
    if (summary.stale > 0) notes.push(`24時間以上 放置 ${summary.stale}件`)

    const waitingIdle = summary.idle + summary.stale

    return {
        key: "tmux",
        label: "tmux",
        value: `稼働 ${summary.running} · 入力待ち ${summary.waiting} · 待機 ${waitingIdle}`,
        // 稼働・入力待ち・待機はラベル語なので控えめに、数字だけ目立たせる（#227）
        valueParts: [
            { text: "稼働 ", muted: true },
            { text: `${summary.running}` },
            { text: " · ", muted: true },
            { text: "入力待ち ", muted: true },
            { text: `${summary.waiting}` },
            { text: " · ", muted: true },
            { text: "待機 ", muted: true },
            { text: `${waitingIdle}` },
        ],
        note: notes.length > 0 ? notes.join(" · ") : "放置なし",
        tone: notes.length > 0 ? "warn" : "neutral",
    }
}

/**
 * AIプロバイダ1件分のチップ（Claude枠・ChatGPT枠、#227）。
 *
 * 取得に失敗した・未設定のプロバイダは windows が空のまま返ってくる（例:
 * src/lib/ai-usage/claude.ts の status "error"/"unconfigured"）。それを素通りすると
 * チップが黙って消え、再ログインが必要といった状態が最上部から見えなくなるため、
 * status を先に見て専用の表示を出す。
 */
function providerChip(
    snapshot: AiUsageSnapshot | null,
    providerId: AiProviderId,
    label: string
): SummaryChip | null {
    const provider = snapshot?.providers.find((candidate) => candidate.id === providerId)
    if (!provider) return null

    if (provider.status !== "ok") {
        return {
            key: providerId,
            label,
            value: provider.status === "error" ? "取得不可" : "未設定",
            note: provider.message,
            tone: provider.status === "error" ? "danger" : "neutral",
        }
    }

    // 複数の枠（例: 5時間・週間）がある場合は一番きついものだけを出す
    const tightest = [...provider.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
    if (!tightest) return null

    const remaining = Math.max(0, Math.round(100 - tightest.usedPercent))

    return {
        key: providerId,
        label,
        value: `残り ${remaining}%`,
        note: `${tightest.label}${tightest.note ? `（${tightest.note}）` : ""}`,
        tone: remainingTone(remaining),
    }
}

function githubChip(snapshot: GitHubUsageSnapshot | null): SummaryChip | null {
    const actions = snapshot?.status === "ok" ? snapshot.actions : null
    if (!actions || actions.allowanceLimitMinutes <= 0) return null

    const remainingMinutes = Math.max(0, actions.allowanceLimitMinutes - actions.allowanceMinutes)
    const remaining = Math.round((remainingMinutes / actions.allowanceLimitMinutes) * 100)

    return {
        key: "github",
        label: "GitHub",
        value: `残 ${remaining}%`,
        note: `Actions ${actions.allowanceMinutes.toLocaleString("ja-JP")} / ${actions.allowanceLimitMinutes.toLocaleString("ja-JP")} 分`,
        tone: remainingTone(remaining),
    }
}

function onePasswordChip(snapshot: OnePasswordUsageSnapshot | null): SummaryChip | null {
    if (snapshot?.status !== "ok") return null

    // 使い切ると全アプリのデプロイが止まるため、一番きつい枠だけを出す
    const tightest = snapshot.limits
        .filter((limit) => limit.limit > 0)
        .sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)[0]

    if (!tightest) return null

    const remaining = Math.round((tightest.remaining / tightest.limit) * 100)
    const scope = tightest.type === "account" ? "アカウント全体24時間" : "トークン1時間"

    return {
        key: "onepassword",
        label: "1Password",
        value: `残 ${remaining}%`,
        note: `${scope} ${tightest.used.toLocaleString("ja-JP")} / ${tightest.limit.toLocaleString("ja-JP")} 回`,
        tone: remainingTone(remaining),
    }
}

/**
 * 定期ジョブ（systemd timer）の異常（#75）。
 *
 * 正常なときは出さない。定期ジョブは普段ずっと正常で、常時1枠を占めるほどの情報量が無い。
 * 「気づかないと壊れたままになる」ことが問題なので、異常が出たときだけ最上段に現れればよい。
 */
function timerChip(view: HostStatsView | null): SummaryChip | null {
    const summary = summarizeTimers(view?.hosts ?? [])
    if (!summary.available || summary.abnormalNames.length === 0) return null

    return {
        key: "timers",
        label: "定期ジョブ",
        value: `${summary.abnormalNames.length} / ${summary.total} 異常`,
        note: summary.abnormalNames.join("・"),
        tone: "danger",
    }
}

function maintenanceChip(view: HostStatsView | null): SummaryChip | null {
    if (!view?.hosts.length) return null

    const maintenances = view.hosts.map((host) => ({
        label: host.label,
        maintenance: host.latest.maintenance,
    }))

    const updates = maintenances.reduce(
        (total, host) => total + (host.maintenance?.updatesAvailable ?? 0),
        0
    )
    const security = maintenances.reduce(
        (total, host) => total + (host.maintenance?.securityUpdatesAvailable ?? 0),
        0
    )
    const rebootHosts = maintenances
        .filter((host) => host.maintenance?.rebootRequired)
        .map((host) => host.label)

    if (updates === 0 && rebootHosts.length === 0) return null

    const notes = [
        security > 0 ? `セキュリティ ${security}件` : null,
        rebootHosts.length > 0 ? `${rebootHosts.join("・")} は再起動待ち` : null,
    ].filter((note): note is string => note !== null)

    return {
        key: "maintenance",
        label: "メンテ",
        value: updates > 0 ? `更新 ${updates}件` : "再起動待ち",
        note: notes.length > 0 ? notes.join(" · ") : "適用待ちの更新あり",
        tone: security > 0 || rebootHosts.length > 0 ? "danger" : "warn",
    }
}

/** チップの注記は1行で出すため、長い文は途中で切る */
function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * AIDE（MCPサーバー）の動作状況（#237）。
 *
 * 取得に失敗したときは消さずに「取得不可」を出す。AIDEが止まっているときこそ最上段で気づきたいため。
 * 注意の文面は1行に収まらないので、原因がジョブならその名前だけを添える。
 */
function aideChip(snapshot: AideStatusSnapshot | null): SummaryChip | null {
    if (!snapshot || snapshot.status === "unconfigured") return null

    if (snapshot.status === "error" || !snapshot.health) {
        return {
            key: "aide",
            label: "AIDE",
            value: "取得不可",
            note: snapshot.message ? clip(snapshot.message, 40) : undefined,
            tone: "danger",
        }
    }

    const { health } = snapshot
    if (health.severity !== "warn" && health.severity !== "danger") {
        return {
            key: "aide",
            label: "AIDE",
            value: "正常",
            note: `v${health.server.version || "?"} · 稼働 ${formatAideDuration(Math.round(health.server.uptimeSeconds / 60))}`,
            tone: "ok",
        }
    }

    const failed = health.jobs.filter((job) => job.lastRun && !job.lastRun.ok).map((job) => job.name)
    const late = health.jobs
        .filter((job) => job.lastRun?.ok && job.severity === "warn")
        .map((job) => job.name)
    const notes = [
        failed.length > 0 ? `${failed.join("・")} が失敗` : null,
        late.length > 0 ? `${late.join("・")} が遅れている` : null,
    ].filter((note): note is string => note !== null)

    const count = health.attention.length
    const label = AIDE_SEVERITY_LABEL[health.severity]
    const firstMessage = health.attention[0]?.message

    return {
        key: "aide",
        label: "AIDE",
        value: count > 0 ? `${label} ${count}` : label,
        note: notes.length > 0 ? notes.join(" · ") : firstMessage ? clip(firstMessage, 40) : undefined,
        tone: health.severity,
    }
}

/**
 * 画面上部のサマリーを組み立てる。
 *
 * タブを切り替えても隠れない場所に置くため、ここに出すのは「異常かどうかの判断に要るもの」だけに絞る。
 * 出す材料が無いチップ（未設定の監視・tmuxの無いホストなど）は行ごと省く。
 */
export function buildSummaryChips(input: {
    hostStats: HostStatsView | null
    tmuxSessions: TmuxSessionView[]
    uptimeKuma: UptimeKumaMonitor[]
    uptimeRobot: UptimeRobotMonitor[]
    aiUsage: AiUsageSnapshot | null
    githubUsage: GitHubUsageSnapshot | null
    onepasswordUsage: OnePasswordUsageSnapshot | null
    aideStatus: AideStatusSnapshot | null
}): SummaryChip[] {
    return [
        hostChip(input.hostStats),
        tmuxChip(input.hostStats, input.tmuxSessions),
        providerChip(input.aiUsage, "claude", "Claude"),
        providerChip(input.aiUsage, "chatgpt", "ChatGPT"),
        githubChip(input.githubUsage),
        monitorChip(input.uptimeKuma, input.uptimeRobot),
        // AIDEは監視と同じく「サービスが動いているか」を表すため、監視の隣に置く（#237）
        aideChip(input.aideStatus),
        // Issue #227 に列挙の無いその他チップ（異常時のみ出る定期ジョブ・メンテと、常時出る1Password）
        // は「他対応が必要なもの」としてまとめて末尾に置く
        timerChip(input.hostStats),
        maintenanceChip(input.hostStats),
        onePasswordChip(input.onepasswordUsage),
    ].filter((chip): chip is SummaryChip => chip !== null)
}
