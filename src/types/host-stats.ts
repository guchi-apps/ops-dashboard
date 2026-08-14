/** 使用量（メモリ・Swap・ディスク共通） */
export interface HostStatsUsage {
    usedBytes: number
    totalBytes: number
    usedPercent: number
}

export interface HostStatsDisk extends HostStatsUsage {
    path: string
}

export interface HostStatsService {
    name: string
    /** systemctl is-active の出力（active / inactive / failed など） */
    state: string
    active: boolean
}

/** 資源を食っている上位プロセス。CPU順とメモリ順で同じ形のものを別々に持つ */
export interface HostStatsProcess {
    name: string
    cpuPercent: number
    /** 常駐セットサイズ（RSS）。これを送らない世代のエージェントでは undefined */
    memoryBytes?: number
}

/** 秒あたりの転送量。ネットワークとディスクI/Oで使う */
export interface HostStatsRate {
    inBytesPerSecond: number
    outBytesPerSecond: number
}

/** 運用上の気づき（再起動待ち・未適用の更新） */
export interface HostStatsMaintenance {
    rebootRequired: boolean
    /** 適用可能なパッケージ更新の件数。取得手段が無い環境では undefined */
    updatesAvailable?: number
    securityUpdatesAvailable?: number
}

export interface HostStatsSessions {
    /** ログイン中のセッション数 */
    count: number
    /** ログイン中のユーザー名（重複を除いたもの） */
    users: string[]
}

/**
 * tmux のセッション1つ分。
 *
 * サブPCは Claude Code のセッションを常駐させるホストで、リポジトリをまたいだ作業セッションが
 * 同じ `tmux ls` に並ぶ。いま何が動いているかが分からないと二重起動や放置に気づけないため、
 * ホストのメトリクスと一緒に送ってもらう。
 */
export interface HostStatsTmuxSession {
    name: string
    /** セッション内のウィンドウ数 */
    windows: number
    /** クライアントがアタッチしているか（放置セッションの見分けに使う） */
    attached: boolean
    /** セッションの作成時刻（ISO 8601） */
    createdAt?: string
    /** セッションの持ち主。ソケットの所有者から引く */
    user?: string
    /**
     * ペインで動いている、シェル以外のコマンド（重複を除いたもの）。
     * これを送らない世代のエージェントでは undefined になる。
     */
    commands?: string[]
    /**
     * シェル以外のコマンドが動いているか（＝作業中か）。
     * アタッチの有無では、デタッチしたまま裏で走っているセッションを見分けられないため別に持つ。
     * これを送らない世代のエージェントでは undefined になる。
     */
    busy?: boolean
    /** セッション内で最後に活動があった時刻（ISO 8601）。放置の判定に使う */
    lastActivityAt?: string
    /** アクティブなペインの作業ディレクトリ。ホームディレクトリは ~ に置き換えて送られる */
    path?: string
    /**
     * issue-deck の回収が「このセッションを畳まない」と判断した理由（#59）。
     * 付くのは回収の判定に乗ったセッションだけで、手で立てたセッションでは undefined。
     */
    holdReason?: string
    /**
     * その理由になった時刻（ISO 8601）。
     * **「最後に判定した時刻」ではない。** 回収は理由が変わったときだけ記録を書き直すため、
     * 同じ理由で止まっている期間が読める。回収自体が動いているかの判定には使えない。
     */
    holdReasonAt?: string
    /** Claude Code のフックが最後に記録したイベント名（Stop / permission_prompt など） */
    lastEventName?: string
    /** そのイベントの時刻（ISO 8601） */
    lastEventAt?: string
    /** セッションが対応するIssueのリポジトリ（owner/repo）。形式を満たさない値は落として送られない */
    issueRepository?: string
    /** セッションが対応するIssueの番号 */
    issueNumber?: number
}

/**
 * 各ホスト上のエージェント（scripts/host-stats/agent.sh）が送ってくる1回分のメトリクス。
 *
 * VPS・サブPCとも同じ経路（push型）に一本化しており、ダッシュボード自身が動いている
 * ホストであっても /proc を直接読むのではなく、このレポートを受け取って表示する。
 */
export interface HostStatsReport {
    /** ペイロード形式のバージョン。エージェントとダッシュボードの世代がずれたら弾く */
    version: number
    /** ホストの識別子。保存先のディレクトリ名になる。未指定ならホスト名から作る */
    id?: string
    /** 画面の見出しに使う表示名。未指定ならホスト名 */
    label?: string
    hostname: string
    os?: string
    kernel?: string
    /** エージェント側の収集時刻（ISO 8601）。時刻ずれの調査用で、鮮度判定には使わない */
    collectedAt?: string
    cpuPercent: number
    memory: HostStatsUsage
    swap?: HostStatsUsage
    disks: HostStatsDisk[]
    loadAverage: [number, number, number]
    uptimeSeconds: number
    temperatureCelsius?: number
    network?: HostStatsRate
    diskIo?: HostStatsRate
    topProcesses?: HostStatsProcess[]
    /**
     * メモリ使用量の多い順の上位プロセス。
     * メモリ枯渇でホストが止まる事故では、犯人がCPU順の一覧に出てこないため別に持つ。
     */
    topMemoryProcesses?: HostStatsProcess[]
    maintenance?: HostStatsMaintenance
    sessions?: HostStatsSessions
    /** tmux のセッション一覧。tmux が入っていないホストでは undefined（0件なら空配列） */
    tmuxSessions?: HostStatsTmuxSession[]
    /**
     * tmux セッションの総数。tmuxSessions は上限で切られるため、切り捨てた分を含む実数を別に持つ。
     * これを送らない世代のエージェントでは undefined。
     */
    tmuxSessionTotal?: number
    services: HostStatsService[]
}

/** 保管済みの最新レポート。鮮度判定にはサーバー側で打った receivedAt を使う */
export interface HostStatsSnapshot extends HostStatsReport {
    id: string
    receivedAt: string
}

/** 履歴の1点。24時間分をJSONLで持つため、キー名は短くしている */
export interface HostStatsHistoryPoint {
    /** epoch 秒 */
    t: number
    cpu: number
    mem: number
    disk: number
    load: number
    swap?: number
    temp?: number
    /** ネットワーク受信・送信（バイト/秒） */
    rx?: number
    tx?: number
    /** ディスク読み込み・書き込み（バイト/秒） */
    ior?: number
    iow?: number
}

/** 1ホスト分の表示データ */
export interface HostStatsHostView {
    id: string
    label: string
    latest: HostStatsSnapshot
    /** 最終受信からの経過秒数 */
    ageSeconds: number
    online: boolean
    history: HostStatsHistoryPoint[]
}

/** GET /api/host-stats のレスポンス */
export interface HostStatsView {
    /** 一度も受信していないホストは含まれない（空ならセクションごと非表示） */
    hosts: HostStatsHostView[]
    offlineAfterSeconds: number
    historyHours: number
}
