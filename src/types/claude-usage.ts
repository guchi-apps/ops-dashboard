/**
 * iPhone のロック画面ウィジェット（Scriptable）向けに返す、Claude の利用枠のレスポンス。
 *
 * 上流（Anthropic の非公開エンドポイント）のJSONはキー構成が変わりうるため、
 * ダッシュボード表示用の `AiProviderUsage` のように解釈し直さず、そのまま素通しする。
 * ウィジェット側が知っているキー（`five_hour` / `seven_day` など）だけを読む前提。
 */
export interface ClaudeUsageWidgetResponse {
    /** 上流から実際に取得した時刻（＝キャッシュを作った時刻） */
    collected_at: string
    /** 上流の取得に失敗し、古いキャッシュを返しているとき true */
    stale: boolean
    /** stale のときだけ入る、上流の失敗理由 */
    error?: string
    /** 上流のレスポンスをそのまま展開したもの */
    [key: string]: unknown
}
