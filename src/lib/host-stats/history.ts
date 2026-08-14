import type { HostStatsHistoryPoint } from "@/types/host-stats"

/** 履歴から1系列だけ取り出す。値の無い点（項目を送らないホスト）は落とす */
export function pickSeries(
    history: HostStatsHistoryPoint[],
    key: keyof HostStatsHistoryPoint
): number[] {
    return history
        .map((point) => point[key])
        .filter((value): value is number => typeof value === "number")
}

/** 受信・送信のように対になる系列を合計する（グラフ1本にまとめて出すため） */
export function sumSeries(a: number[], b: number[]): number[] {
    if (a.length !== b.length) return a
    return a.map((value, index) => value + b[index])
}
