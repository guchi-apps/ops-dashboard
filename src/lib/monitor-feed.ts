/**
 * 監視サービス（Uptime Kuma・UptimeRobot）1系統ぶんの取得結果。
 *
 * 取得に失敗したことと「モニターが0件」であることを区別するために、モニターの一覧と
 * 失敗の理由を一緒に持つ（#276）。区別が無いと、監視サービスが落ちたとき画面最上部の
 * 監視チップが黙って消え、片方だけ落ちたときは残りの件数で「すべて正常」と出てしまう。
 *
 * - `error === null`: 取得できた。未設定の系統も、`monitors` が空のままここに入る
 * - `error !== null`: 取得に失敗した。値は画面に出す短い理由（HTTPステータスなど）
 *
 * `/api/uptime-kuma` と `/api/monitors` はこの形をそのまま返す。従来の `{ monitors }` に
 * `error` を足しただけなので、`monitors` だけを読む呼び出し元（AIDE）はそのまま動く。
 */
export interface MonitorFeed<T> {
    monitors: T[]
    error: string | null
}

export function monitorFeedOk<T>(monitors: T[]): MonitorFeed<T> {
    return { monitors, error: null }
}

export function monitorFeedError<T>(error: string): MonitorFeed<T> {
    return { monitors: [], error }
}
