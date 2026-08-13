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

/** CPUを食っている上位プロセス */
export interface HostStatsProcess {
    name: string
    cpuPercent: number
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
    maintenance?: HostStatsMaintenance
    sessions?: HostStatsSessions
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
