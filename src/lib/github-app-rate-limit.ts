import { readOpsApiToken } from "@/lib/ops-api-token"
import type {
    GitHubAppInstallationRateLimit,
    GitHubAppRateLimitResource,
    GitHubAppRateLimits,
} from "@/types/github-usage"

/**
 * GitHub Appのインストールトークンの枠（issue-deckの「GitHub使用量」と同じ数字）は、
 * issue-deckだけが持つトークンで取れるため、サーバー間で読む（#517）。
 * `GH_USAGE_TOKEN`（PAT）の `/rate_limit` は個人の枠で別物。
 */
const ENDPOINT_PATH = "/api/github/rate-limit/apps"
const TIMEOUT_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function parseResource(value: unknown): GitHubAppRateLimitResource | null {
    if (!isRecord(value)) return null
    const { key, label, limit, remaining, used, reset } = value
    if (
        typeof key !== "string" ||
        typeof label !== "string" ||
        typeof limit !== "number" ||
        typeof remaining !== "number" ||
        typeof used !== "number" ||
        typeof reset !== "number"
    ) {
        return null
    }
    return { key, label, limit, remaining, used, resetsAt: new Date(reset * 1000).toISOString() }
}

/** 1件でも形が違えば全体を捨てる。数字が黙って欠けるより「取得不可」を出す */
export function parseAppRateLimitResponse(body: unknown): GitHubAppInstallationRateLimit[] | null {
    if (!isRecord(body) || !Array.isArray(body.installations)) return null

    const installations: GitHubAppInstallationRateLimit[] = []
    for (const installation of body.installations) {
        if (!isRecord(installation) || typeof installation.accountLogin !== "string") return null
        if (!Array.isArray(installation.resources)) return null

        const resources: GitHubAppRateLimitResource[] = []
        for (const resource of installation.resources) {
            const parsed = parseResource(resource)
            if (!parsed) return null
            resources.push(parsed)
        }
        installations.push({ accountLogin: installation.accountLogin, resources })
    }
    return installations
}

function failure(message: string): GitHubAppRateLimits {
    return { status: "error", message, installations: [] }
}

export async function fetchGitHubAppRateLimits(): Promise<GitHubAppRateLimits> {
    const baseUrl = process.env.ISSUE_DECK_URL?.trim()
    const token = await readOpsApiToken()
    if (!baseUrl || !token) {
        return { status: "unconfigured", installations: [] }
    }

    try {
        const res = await fetch(new URL(ENDPOINT_PATH, baseUrl), {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
            // 401はトークンのずれ、404はissue-deck側にAPIがまだ無い（デプロイ前）
            return failure(`HTTP ${res.status}`)
        }
        const installations = parseAppRateLimitResponse(await res.json())
        if (!installations) return failure("応答の形式が想定と異なります")
        return { status: "ok", installations }
    } catch {
        return failure("接続できません")
    }
}
