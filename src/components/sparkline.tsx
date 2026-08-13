/**
 * 24時間分の推移を小さく描くための折れ線。
 * チャートライブラリを足さずに済むよう、インラインSVGで最小限だけ描く。
 */
interface SparklineProps {
    values: number[]
    /** 縦軸の範囲。使用率は 0〜100 固定、Load Average や温度は呼び出し側で指定する */
    min?: number
    max?: number
    className?: string
    label: string
}

const VIEW_WIDTH = 100
const VIEW_HEIGHT = 24

export function Sparkline({ values, min = 0, max = 100, className, label }: SparklineProps) {
    // 点が1つだけだと線にならないため、2点そろうまでは何も描かない
    if (values.length < 2) return null

    const range = max - min || 1
    const points = values.map((value, index) => {
        const x = (index / (values.length - 1)) * VIEW_WIDTH
        const ratio = Math.min(1, Math.max(0, (value - min) / range))
        return [x, VIEW_HEIGHT - ratio * VIEW_HEIGHT] as const
    })

    const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
    const area = `0,${VIEW_HEIGHT} ${line} ${VIEW_WIDTH},${VIEW_HEIGHT}`

    return (
        <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            className={className}
            role="img"
            aria-label={label}
        >
            <polygon points={area} fill="currentColor" fillOpacity={0.15} />
            <polyline
                points={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    )
}
