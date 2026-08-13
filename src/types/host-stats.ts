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

/**
 * サブPC上のエージェント（scripts/host-stats/agent.sh）が送ってくる1回分のメトリクス。
 * VPS Status と違い自ホストを読めないため、この形でPOSTされたものを保管して表示する。
 */
export interface HostStatsReport {
    /** ペイロード形式のバージョン。エージェントとダッシュボードの世代がずれたら弾く */
    version: number
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
    services: HostStatsService[]
}

/** 保管済みの最新レポート。鮮度判定にはサーバー側で打った receivedAt を使う */
export interface HostStatsSnapshot extends HostStatsReport {
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
}

/** GET /api/host-stats のレスポンス */
export interface HostStatsView {
    /** 一度も受信していなければ null（ダッシュボードはセクションごと非表示にする） */
    latest: HostStatsSnapshot | null
    label: string
    /** 最終受信からの経過秒数 */
    ageSeconds: number | null
    online: boolean
    offlineAfterSeconds: number
    historyHours: number
    history: HostStatsHistoryPoint[]
}
