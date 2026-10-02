import { findModel, listModels, type ModelFamily } from "@/lib/ai-app-usage/models"

/**
 * グラフの積み上げ用の色（#498）。同じ系統でも単価の違うモデル（Fable 5.1 と Opus 5.5 など）を
 * 見分けられるよう、系統の色相のまま、モデルごとに明るさを変える。画面側では必ずモデル名の凡例も出す。
 * 純粋関数のみ（画面から読む）。
 */
const FAMILY_HSL: Record<ModelFamily, { h: number; s: number }> = {
    opus: { h: 229, s: 72 },
    sonnet: { h: 173, s: 52 },
    haiku: { h: 44, s: 72 },
    jev: { h: 340, s: 70 },
    gpt: { h: 27, s: 83 },
}

export const UNKNOWN_MODEL_COLOR = "#8793a8"

const LIGHTNESS_MIN = 38
const LIGHTNESS_MAX = 80

/** 単価表に無いモデルは無彩色。ある場合は、同じ系統の中での登録順で明るさを均等に割り当てる */
export function modelColor(model: string): string {
    const info = findModel(model)
    if (!info) return UNKNOWN_MODEL_COLOR

    const siblings = listModels().filter((item) => item.family === info.family)
    const index = Math.max(0, siblings.findIndex((item) => item.id === info.id))
    const step = siblings.length > 1 ? (LIGHTNESS_MAX - LIGHTNESS_MIN) / (siblings.length - 1) : 0
    const { h, s } = FAMILY_HSL[info.family]
    return `hsl(${h} ${s}% ${Math.round(LIGHTNESS_MIN + step * index)}%)`
}
