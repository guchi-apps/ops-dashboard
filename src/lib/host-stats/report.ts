import type {
    HostStatsDisk,
    HostStatsMaintenance,
    HostStatsProcess,
    HostStatsRate,
    HostStatsReport,
    HostStatsService,
    HostStatsSessions,
    HostStatsUsage,
} from "@/types/host-stats"

/**
 * エージェントが送るペイロードの形式バージョン。
 * エージェント側を非互換に変えたらここを上げ、古いエージェントからのPOSTを弾く。
 */
export const HOST_STATS_PAYLOAD_VERSION = 1

/** 1レポートに載せられる件数の上限（壊れた・悪意あるペイロードで肥大させないため） */
const MAX_DISKS = 8
const MAX_SERVICES = 20
const MAX_PROCESSES = 5
const MAX_SESSION_USERS = 10
const MAX_TEXT_LENGTH = 120

/** ホスト識別子に使える文字。保存先のディレクトリ名になるため、パス区切りなどを通さない */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class HostStatsReportError extends Error {}

function fail(message: string): never {
    throw new HostStatsReportError(message)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} がオブジェクトではありません`)
    return value as Record<string, unknown>
}

function asNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} が数値ではありません`)
    return value
}

function asText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) fail(`${field} が文字列ではありません`)
    return value.slice(0, MAX_TEXT_LENGTH)
}

function asOptionalText(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined
    return asText(value, field)
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

function nonNegative(value: number): number {
    return Math.max(0, value)
}

function parseUsage(value: unknown, field: string): HostStatsUsage {
    const record = asRecord(value, field)
    return {
        usedBytes: nonNegative(asNumber(record.usedBytes, `${field}.usedBytes`)),
        totalBytes: nonNegative(asNumber(record.totalBytes, `${field}.totalBytes`)),
        usedPercent: clampPercent(asNumber(record.usedPercent, `${field}.usedPercent`)),
    }
}

function parseDisks(value: unknown): HostStatsDisk[] {
    if (!Array.isArray(value)) fail("disks が配列ではありません")
    if (value.length === 0) fail("disks が空です")

    return value.slice(0, MAX_DISKS).map((entry, index) => ({
        ...parseUsage(entry, `disks[${index}]`),
        path: asText(asRecord(entry, `disks[${index}]`).path, `disks[${index}].path`),
    }))
}

function parseServices(value: unknown): HostStatsService[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) fail("services が配列ではありません")

    return value.slice(0, MAX_SERVICES).map((entry, index) => {
        const record = asRecord(entry, `services[${index}]`)
        const state = asText(record.state, `services[${index}].state`)
        return {
            name: asText(record.name, `services[${index}].name`),
            state,
            active: state === "active",
        }
    })
}

function parseLoadAverage(value: unknown): [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3) fail("loadAverage が3要素の配列ではありません")
    const [one, five, fifteen] = value.map((entry, index) =>
        nonNegative(asNumber(entry, `loadAverage[${index}]`))
    )
    return [one, five, fifteen]
}

function parseRate(value: unknown, field: string): HostStatsRate | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, field)
    return {
        inBytesPerSecond: nonNegative(asNumber(record.inBytesPerSecond, `${field}.inBytesPerSecond`)),
        outBytesPerSecond: nonNegative(asNumber(record.outBytesPerSecond, `${field}.outBytesPerSecond`)),
    }
}

function parseProcesses(value: unknown): HostStatsProcess[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) fail("topProcesses が配列ではありません")

    return value.slice(0, MAX_PROCESSES).map((entry, index) => {
        const record = asRecord(entry, `topProcesses[${index}]`)
        return {
            name: asText(record.name, `topProcesses[${index}].name`),
            cpuPercent: clampPercent(asNumber(record.cpuPercent, `topProcesses[${index}].cpuPercent`)),
        }
    })
}

function parseMaintenance(value: unknown): HostStatsMaintenance | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "maintenance")

    const count = (key: string): number | undefined =>
        record[key] === undefined || record[key] === null
            ? undefined
            : Math.round(nonNegative(asNumber(record[key], `maintenance.${key}`)))

    return {
        rebootRequired: record.rebootRequired === true,
        updatesAvailable: count("updatesAvailable"),
        securityUpdatesAvailable: count("securityUpdatesAvailable"),
    }
}

function parseSessions(value: unknown): HostStatsSessions | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "sessions")
    const users = Array.isArray(record.users) ? record.users : []

    return {
        count: Math.round(nonNegative(asNumber(record.count, "sessions.count"))),
        users: users.slice(0, MAX_SESSION_USERS).map((user, index) => asText(user, `sessions.users[${index}]`)),
    }
}

/** ホスト名から保存先に使える識別子を作る（エージェントが id を送ってこない場合の保険） */
function slugFromHostname(hostname: string): string {
    const slug = hostname
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 64)
    return slug || "host"
}

/** POSTされたJSONを検証し、保管できる形に正規化する。壊れていれば HostStatsReportError を投げる */
export function parseHostStatsReport(input: unknown): HostStatsReport & { id: string } {
    const record = asRecord(input, "payload")

    const version = asNumber(record.version, "version")
    if (version !== HOST_STATS_PAYLOAD_VERSION) {
        fail(`version ${version} は未対応です（このダッシュボードは ${HOST_STATS_PAYLOAD_VERSION}）`)
    }

    const swap = record.swap === undefined || record.swap === null ? undefined : parseUsage(record.swap, "swap")
    const temperature =
        record.temperatureCelsius === undefined || record.temperatureCelsius === null
            ? undefined
            : Math.round(asNumber(record.temperatureCelsius, "temperatureCelsius") * 10) / 10

    const hostname = asText(record.hostname, "hostname")
    const id = record.id === undefined || record.id === null ? slugFromHostname(hostname) : asText(record.id, "id")
    if (!ID_PATTERN.test(id)) {
        fail(`id "${id}" は英小文字・数字・ハイフン・アンダースコアのみ（64文字以内）にしてください`)
    }

    return {
        version,
        id,
        label: asOptionalText(record.label, "label"),
        hostname,
        os: asOptionalText(record.os, "os"),
        kernel: asOptionalText(record.kernel, "kernel"),
        collectedAt: asOptionalText(record.collectedAt, "collectedAt"),
        cpuPercent: clampPercent(asNumber(record.cpuPercent, "cpuPercent")),
        memory: parseUsage(record.memory, "memory"),
        swap,
        disks: parseDisks(record.disks),
        loadAverage: parseLoadAverage(record.loadAverage),
        uptimeSeconds: Math.round(nonNegative(asNumber(record.uptimeSeconds, "uptimeSeconds"))),
        temperatureCelsius: temperature,
        network: parseRate(record.network, "network"),
        diskIo: parseRate(record.diskIo, "diskIo"),
        topProcesses: parseProcesses(record.topProcesses),
        maintenance: parseMaintenance(record.maintenance),
        sessions: parseSessions(record.sessions),
        services: parseServices(record.services),
    }
}
