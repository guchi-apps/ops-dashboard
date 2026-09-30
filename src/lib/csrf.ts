import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from "@/lib/csrf-headers"

/**
 * セッション（Cookie）だけで受ける書き込みAPIのCSRF対策（#466）。
 *
 * `request.json()` は Content-Type を見ないため、`enctype="text/plain"` のフォームでもJSONの本文を
 * 送れる。同一サイト扱いの別アプリ（`*.gucchii.com`）にXSSがあると、Cookie付きで送れてしまうので、
 * 単純なフォーム送信では付けられない専用ヘッダを求める。**GET以外でセッションを受けるルートは、
 * 認証の直後にこれを通すこと。** 通らなければ返すレスポンスを、通れば `null` を返す。
 *
 * Bearerトークンで受ける経路（サーバー間）はブラウザのCookieに乗らないので対象外。
 */
export function rejectCrossSiteRequest(request: Request): Response | null {
    if (request.headers.get(REQUESTED_WITH_HEADER) === REQUESTED_WITH_VALUE) return null
    return Response.json({ error: "不正なリクエストです" }, { status: 403 })
}
