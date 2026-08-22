"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * スマホでタブ本文を左右にスワイプして隣のタブへ移るための部品（#136）。
 *
 * ライブラリは足さず、タッチイベントだけで組む。マウス・トラックパッドでは発火しないため、
 * PCでの操作は従来どおりタブのクリックだけになる。
 */

/** これ以上動かしたらタブを切り替える距離(px)。短すぎるとタップのブレで誤爆する */
const SWIPE_THRESHOLD_PX = 60

/**
 * 横スワイプと判定する最低の移動量(px)。ここを超えるまでは縦スクロールか横スワイプかを決めず、
 * 一度決めたら指を離すまで変えない（途中で切り替わると指の動きに対して画面が跳ねる）
 */
const DIRECTION_LOCK_PX = 12

/** 指の動きに本文を追従させる量の上限(px)。切り替わらない端でも「動いた」ことだけは伝える */
const MAX_DRAG_PX = 48

/** 切り替え後のスライドインの長さ(ms)。globals.css の --animate-swipe-in-* と揃える */
const ENTER_ANIMATION_MS = 200

/**
 * 触れた場所が横スクロールできる領域なら、スワイプとして扱わない。
 *
 * ステータスチップ帯（`status-strip.tsx`）のように横スクロールする箇所を拾ってしまうと、
 * 本来のスクロールができなくなる。
 */
function startsInsideHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
    let node = target instanceof Element ? target : null

    while (node && node !== root) {
        if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1) {
            const overflowX = window.getComputedStyle(node).overflowX
            if (overflowX === "auto" || overflowX === "scroll") return true
        }
        node = node.parentElement
    }

    return false
}

export function SwipeTabs({
    children,
    label,
    canGoPrevious,
    canGoNext,
    onPrevious,
    onNext,
    /** 表示中のタブ。変わるたびに中身を作り直し、スライドインを1回だけ流す */
    contentKey,
}: {
    children: React.ReactNode
    label: string
    canGoPrevious: boolean
    canGoNext: boolean
    onPrevious: () => void
    onNext: () => void
    contentKey: string
}) {
    const rootRef = useRef<HTMLDivElement>(null)
    const gesture = useRef<{
        startX: number
        startY: number
        /** null = まだ縦横どちらの操作か決まっていない */
        horizontal: boolean | null
    } | null>(null)

    const [dragX, setDragX] = useState(0)
    const [dragging, setDragging] = useState(false)

    /**
     * 次に描画する中身をどちら側から出すか。スワイプで切り替えた瞬間に決める。
     * state ではなく ref に持つのは、切り替え時には既にドラッグ量を 0 に戻していて、
     * state からは向きを読めないため
     */
    const enterDirection = useRef<"left" | "right" | null>(null)
    const renderedKey = useRef(contentKey)
    const [enterFrom, setEnterFrom] = useState<"left" | "right" | null>(null)

    const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
        const root = rootRef.current
        if (!root) return
        // 2本指はピンチなどブラウザ側の操作なので触らない
        if (event.touches.length !== 1 || startsInsideHorizontalScroller(event.target, root)) {
            gesture.current = null
            return
        }

        const touch = event.touches[0]
        gesture.current = { startX: touch.clientX, startY: touch.clientY, horizontal: null }
    }, [])

    const handleTouchMove = useCallback(
        (event: React.TouchEvent<HTMLDivElement>) => {
            const current = gesture.current
            if (!current || event.touches.length !== 1) return

            const touch = event.touches[0]
            const deltaX = touch.clientX - current.startX
            const deltaY = touch.clientY - current.startY

            if (current.horizontal === null) {
                if (Math.abs(deltaX) < DIRECTION_LOCK_PX && Math.abs(deltaY) < DIRECTION_LOCK_PX) return
                // 横のほうが明確に大きいときだけ横スワイプ。斜めは縦スクロール優先にして、
                // 一覧を上下に読んでいる最中にタブが変わってしまうのを避ける
                current.horizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.5
                if (current.horizontal) setDragging(true)
            }

            if (!current.horizontal) return

            // 端では追従量を減らし、これ以上先が無いことを手触りで伝える
            const resisted =
                (deltaX > 0 && !canGoPrevious) || (deltaX < 0 && !canGoNext) ? deltaX * 0.25 : deltaX
            setDragX(Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, resisted)))
        },
        [canGoNext, canGoPrevious]
    )

    const finishGesture = useCallback(
        (event: React.TouchEvent<HTMLDivElement>) => {
            const current = gesture.current
            gesture.current = null
            setDragging(false)
            setDragX(0)
            if (!current || !current.horizontal) return

            const touch = event.changedTouches[0]
            if (!touch) return

            const deltaX = touch.clientX - current.startX
            if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return

            if (deltaX < 0 && canGoNext) {
                // 指を左へ動かした = 次のタブ。新しい中身は右から入ってくる
                enterDirection.current = "right"
                onNext()
            } else if (deltaX > 0 && canGoPrevious) {
                enterDirection.current = "left"
                onPrevious()
            }
        },
        [canGoNext, canGoPrevious, onNext, onPrevious]
    )

    useEffect(() => {
        if (renderedKey.current === contentKey) return
        renderedKey.current = contentKey

        // タブのクリックで切り替えた場合は向きが無い。その場合はアニメーションを付けない
        const direction = enterDirection.current
        enterDirection.current = null
        if (!direction) return

        setEnterFrom(direction)
        const timer = window.setTimeout(() => setEnterFrom(null), ENTER_ANIMATION_MS)
        return () => window.clearTimeout(timer)
    }, [contentKey])

    return (
        <div
            ref={rootRef}
            role="tabpanel"
            aria-label={label}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={finishGesture}
            onTouchCancel={finishGesture}
            // 縦スクロールとピンチは残しつつ、横方向のブラウザ既定動作は抑える。
            // この内側に横スクロールする領域を足すときは、その要素に touch-auto を付ける
            className="touch-pan-y"
        >
            <div
                key={contentKey}
                style={dragging ? { transform: `translate3d(${dragX}px, 0, 0)` } : undefined}
                className={cn(
                    "motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out",
                    !dragging && enterFrom === "right" && "motion-safe:animate-swipe-in-right",
                    !dragging && enterFrom === "left" && "motion-safe:animate-swipe-in-left"
                )}
            >
                {children}
            </div>
        </div>
    )
}
