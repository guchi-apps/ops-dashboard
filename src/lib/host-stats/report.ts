import type {
    HostStatsDisk,
    HostStatsReport,
    HostStatsService,
    HostStatsUsage,
} from "@/types/host-stats"

/**
 * エージェントが送るペイロードの形式バージョン。
 * エージェント側を非互換に変えたらここを上げ、古いエージェントからのPOSTを弾く。
 */
export const HOST_STATS_PAYLOAD_VERSION = 1

/** 1レポートに載せられるディスク・サービスの上限（壊れた・悪意あるペイロードで肥大させないため） */
const MAX_DISKS = 8
const MAX_SERVICES = 20
const MAX_TEXT_LENGTH = 120

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

/** POSTされたJSONを検証し、保管できる形に正規化する。壊れていれば HostStatsReportError を投げる */
export function parseHostStatsReport(input: unknown): HostStatsReport {
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

    return {
        version,
        hostname: asText(record.hostname, "hostname"),
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
        services: parseServices(record.services),
    }
}
