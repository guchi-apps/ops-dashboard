/**
 * ok           — 取得できた
 * unconfigured — トークンまたは組織名が未設定
 * error        — 設定はあるが取得に失敗した
 */
export type GitHubUsageStatus = "ok" | "unconfigured" | "error"

/** 課金レポートに現れたリポジトリ1件分のActions実行時間 */
export interface GitHubActionsRepoUsage {
    name: string
    minutes: number
    /**
     * public リポジトリのActionsは無制限に無料のため、無料枠を消費するのは private のみ。
     * 内訳を見たときに、なぜ合計と無料枠の消費量が一致しないのかが分かるように持たせる。
     * ここに入るのは「今」の公開状態で、月の途中で切り替えた場合は下記と食い違う。
     */
    isPrivate: boolean
    /**
     * このリポジトリが無料枠を消費した分数。非公開だった期間の分だけが入る。
     * 月の途中で公開へ切り替えたリポジトリは `isPrivate` が false でもここが 0 にならない。
     */
    allowanceMinutes: number
}

export interface GitHubActionsUsage {
    /** 無料枠を消費した分数（private リポジトリのみ、実行環境ごとの倍率を適用後） */
    allowanceMinutes: number
    /** 無料枠の上限（分） */
    allowanceLimitMinutes: number
    /** 今月の総実行時間（public を含む全リポジトリの実時間） */
    totalMinutes: number
    /** 今月のストレージ消費（GB時間）。無料枠は容量(MB)基準のため割合は出せず、実績値のみ表示する */
    storageGigabyteHours: number
    /** 今月の消費額（USD、割引前）。GitHubの画面の "consumed usage" にあたる */
    grossAmountUsd: number
    /** 今月の割引額（USD）。公開リポジトリの分と無料枠に収まった分が引かれる */
    discountAmountUsd: number
    /** 今月の課金額（USD）。無料枠に収まっていれば 0 */
    netAmountUsd: number
    /** 実行時間の多い順 */
    repositories: GitHubActionsRepoUsage[]
    /** 集計対象の月の開始時刻（ISO 8601） */
    periodStartsAt: string
    /** 無料枠がリセットされる時刻（ISO 8601、翌月1日 UTC） */
    resetsAt: string
}

export interface GitHubRateLimit {
    limit: number
    remaining: number
    used: number
    /** 制限がリセットされる時刻（ISO 8601） */
    resetsAt: string
}

export interface GitHubUsageSnapshot {
    status: GitHubUsageStatus
    /** status が ok 以外のときに表示する理由 */
    message?: string
    /** 集計対象の組織名 */
    org: string | null
    actions: GitHubActionsUsage | null
    rateLimit: GitHubRateLimit | null
    /** GitHubへ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
}
