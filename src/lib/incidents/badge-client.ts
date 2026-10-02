import type { IncidentSnapshot } from "@/lib/incidents/types"

/**
 * PWAアイコンのバッジ（#495）をページ側から合わせる。
 *
 * 通番（`seq`）の保存先は Service Worker（public/sw.js）と同じ IndexedDB。Service Worker は
 * Push 1件ごとに止められて変数を持てないため、両者がここへ読み書きして、遅れて届いた古い Push や
 * 古い応答で件数が巻き戻らないようにする。DB名・ストア名・キーは sw.js と必ず合わせる。
 */

const DB_NAME = "status-hub-badge"
const STORE = "kv"
const SEQ_KEY = "seq"

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function readSeq(): Promise<number | undefined> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(SEQ_KEY)
        request.onsuccess = () => resolve(typeof request.result === "number" ? request.result : undefined)
        request.onerror = () => reject(request.error)
    })
}

async function writeSeq(seq: number): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite")
        transaction.objectStore(STORE).put(seq, SEQ_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
    })
}

type BadgeNavigator = Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
}

/** 保存済みの通番より古くなければ、バッジを最新の件数に合わせる（0件なら消す） */
export async function applyIncidentBadge(snapshot: Pick<IncidentSnapshot, "count" | "seq">): Promise<void> {
    try {
        const stored = await readSeq()
        if (stored !== undefined && snapshot.seq < stored) return
        await writeSeq(snapshot.seq)

        const nav = navigator as BadgeNavigator
        if (snapshot.count > 0) await nav.setAppBadge?.(snapshot.count)
        else await nav.clearAppBadge?.()
    } catch (error) {
        // 非対応の環境（Safariのタブなど）や、ストレージを使えない設定では何もしない
        console.debug("バッジを更新できませんでした:", error)
    }
}
