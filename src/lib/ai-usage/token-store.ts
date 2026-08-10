import fs from "fs/promises"
import path from "path"

/**
 * OAuth のリフレッシュトークンは使うたびにローテーションするため、
 * 環境変数（1Password 由来）の値をそのまま使い続けることができない。
 * 最新のトークンをVPS上のJSONファイルに永続化し、デプロイをまたいで引き継ぐ。
 *
 * 保存先は deploy.yml の `rm -rf` 対象に含まれないディレクトリを既定とする。
 */
export type TokenProvider = "claude" | "chatgpt"

interface StoredTokens {
    /** この項目を初期化したときの環境変数の値。env が差し替わったら保存内容を破棄する */
    seededFrom: string
    refreshToken: string
    accessToken?: string
    /** アクセストークンの有効期限（epoch ミリ秒） */
    expiresAt?: number
}

type TokenState = Partial<Record<TokenProvider, StoredTokens>>

export interface RefreshResult {
    accessToken: string
    /** ローテーション後のリフレッシュトークン。返らなければ既存の値を使い続ける */
    refreshToken?: string
    /** アクセストークンの有効期間（秒） */
    expiresInSeconds?: number
}

/** 期限ぎりぎりのトークンで叩かないための猶予 */
const EXPIRY_MARGIN_MS = 60_000

function getStatePath(): string {
    return process.env.AI_USAGE_STATE_PATH || path.join(process.cwd(), ".data", "ai-usage-tokens.json")
}

async function readState(): Promise<TokenState> {
    try {
        const raw = await fs.readFile(getStatePath(), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return {}
        return parsed as TokenState
    } catch {
        return {}
    }
}

async function writeState(state: TokenState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tempFile, file)
}

/**
 * ファイルへの read-modify-write を直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

function isFresh(tokens: StoredTokens): boolean {
    return (
        tokens.accessToken !== undefined &&
        tokens.expiresAt !== undefined &&
        tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()
    )
}

/**
 * 有効なアクセストークンを返す。
 * 保存済みのものが期限切れなら `refresh` を呼び、返ってきたトークンを保存する。
 */
export async function getAccessToken(
    provider: TokenProvider,
    envRefreshToken: string,
    refresh: (refreshToken: string) => Promise<RefreshResult>
): Promise<string> {
    return serialize(async () => {
        const state = await readState()
        const stored = state[provider]

        // 環境変数のリフレッシュトークンが差し替わった（=再ログインした）なら保存済みの値は捨てる
        const entry: StoredTokens =
            stored && stored.seededFrom === envRefreshToken
                ? stored
                : { seededFrom: envRefreshToken, refreshToken: envRefreshToken }

        if (isFresh(entry)) {
            return entry.accessToken as string
        }

        let result: RefreshResult
        try {
            result = await refresh(entry.refreshToken)
        } catch (error) {
            // ローテーション後のトークンを取りこぼしている可能性があるため、env の値でもう一度だけ試す
            if (entry.refreshToken === envRefreshToken) throw error
            result = await refresh(envRefreshToken)
        }

        state[provider] = {
            seededFrom: envRefreshToken,
            refreshToken: result.refreshToken ?? entry.refreshToken,
            accessToken: result.accessToken,
            expiresAt:
                result.expiresInSeconds !== undefined
                    ? Date.now() + result.expiresInSeconds * 1000
                    : undefined,
        }
        await writeState(state)

        return result.accessToken
    })
}
