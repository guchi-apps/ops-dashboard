export interface SystemStats {
    cpuPercent: number
    memory: {
        usedBytes: number
        totalBytes: number
        usedPercent: number
    }
    disk: {
        usedBytes: number
        totalBytes: number
        usedPercent: number
        path: string
    }
    loadAverage: [number, number, number]
    uptimeSeconds: number
    hostname: string
    platform: string
    isMock: boolean
}
