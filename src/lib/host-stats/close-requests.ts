import fs from "fs/promises"
import path from "path"
import { ID_PATTERN } from "@/lib/host-stats/report"
import { getHostDataDir, writeFileAtomic } from "@/lib/host-stats/store"
import type { HostStatsTmuxSession } from "@/types/host-stats"

/**
 * tmux セッションを閉じる依頼のキュー（#409）。
 *
 * ダッシュボードはホストからの push 受信専用で、ホストへ指示を送る経路が無い。そのため依頼を
 * ここへ積み、エージェントが毎分の POST の応答（`closeSessions`）で受け取って実行する。
 * 結果の報告は受けず、次の受信でそのセッションが一覧から消えていれば完了とみなす
 * （エージェントが古い・止まっている場合は、期限が来て捨てられるだけ）。
 *
 * **エージェントは root で動く。** 依頼の文字は名前・ユーザー名として使える範囲に絞り、
 * 直近の一覧に載っているセッションと完全に一致したものだけを受け付ける。
 */

/** 依頼が有効な時間。エージェントの送信間隔（1分）の数回ぶん */
export const CLOSE_REQUEST_TTL_MS = 180_000

// 先頭が `-` や `.` の名前は tmux のオプション・特殊指定に読まれうるため通さない
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,63}$/

export interface CloseRequest {
    user: string
    name: string
    /** 依頼した時刻（エポックミリ秒） */
    requestedAt: number
}

export type EnqueueResult = "queued" | "exists" | "invalid" | "unknown-session"

export function isValidCloseTarget(user: unknown, name: unknown): boolean {
    return (
        typeof user === "string" &&
        typeof name === "string" &&
        USER_PATTERN.test(user) &&
        NAME_PATTERN.test(name)
    )
}

function getRequestsPath(hostId: string): string {
    return path.join(getHostDataDir(hostId), "close-requests.json")
}

/** ホストIDはパスに繋ぐため、受信側と同じ規則で検査してから使う */
function assertHostId(hostId: string): void {
    if (!ID_PATTERN.test(hostId)) throw new Error("invalid host id")
}

let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

async function readRequests(hostId: string): Promise<CloseRequest[]> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getRequestsPath(hostId), "utf8"))
        if (!Array.isArray(parsed)) return []

        return parsed.filter(
            (entry): entry is CloseRequest =>
                typeof entry?.requestedAt === "number" && isValidCloseTarget(entry.user, entry.name)
        )
    } catch {
        return []
    }
}

async function writeRequests(hostId: string, requests: CloseRequest[]): Promise<void> {
    await writeFileAtomic(getRequestsPath(hostId), `${JSON.stringify(requests, null, 2)}\n`)
}

const isAlive = (request: CloseRequest, now: number) => now - request.requestedAt < CLOSE_REQUEST_TTL_MS

/** 直近の一覧に載っているセッションだけを、依頼として積む */
export async function enqueueCloseRequest(
    hostId: string,
    target: { user: unknown; name: unknown },
    sessions: HostStatsTmuxSession[],
    now: number = Date.now()
): Promise<EnqueueResult> {
    assertHostId(hostId)
    if (!isValidCloseTarget(target.user, target.name)) return "invalid"

    const { user, name } = target as { user: string; name: string }
    if (!sessions.some((session) => session.user === user && session.name === name)) {
        return "unknown-session"
    }

    return serialize(async () => {
        const requests = (await readRequests(hostId)).filter((request) => isAlive(request, now))
        if (requests.some((request) => request.user === user && request.name === name)) return "exists"

        await writeRequests(hostId, [...requests, { user, name, requestedAt: now }])
        return "queued"
    })
}

/**
 * 受信のたびに呼ぶ。閉じ終わった（一覧から消えた）依頼と期限切れの依頼を捨て、
 * まだ実行されていないものを `<ユーザー>|<セッション名>` の形で返す。
 */
export async function settleCloseRequests(
    hostId: string,
    sessions: HostStatsTmuxSession[] | undefined,
    now: number = Date.now()
): Promise<string[]> {
    assertHostId(hostId)

    return serialize(async () => {
        const before = await readRequests(hostId)
        if (before.length === 0) return []

        // 一覧を送ってこない（tmux が無い）ホストでは消えたかどうか判定できないため、期限だけで捨てる
        const remaining = before.filter(
            (request) =>
                isAlive(request, now) &&
                (sessions === undefined ||
                    sessions.some(
                        (session) => session.user === request.user && session.name === request.name
                    ))
        )
        if (remaining.length !== before.length) await writeRequests(hostId, remaining)

        return remaining.map((request) => `${request.user}|${request.name}`)
    })
}
