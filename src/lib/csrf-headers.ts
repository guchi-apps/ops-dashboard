/** 画面の fetch が必ず付けるヘッダ名と値。単純なフォーム送信では付けられない */
export const REQUESTED_WITH_HEADER = "x-requested-with"
export const REQUESTED_WITH_VALUE = "ops-dashboard"

/** 画面から書き込みAPIを呼ぶときに付けるヘッダ（`fetch` の `headers` へ展開する） */
export const CSRF_HEADERS: Record<string, string> = {
    [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
}
