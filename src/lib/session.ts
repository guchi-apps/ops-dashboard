import { createHash, timingSafeEqual } from "node:crypto";

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/allowed-emails";

export type Session = {
  user: {
    email: string;
    name: string | null;
    image: string | null;
  };
};

/**
 * 現在のセッションを取得する（未認証ならnull、リダイレクトしない）。
 *
 * db-console と異なり、破壊的操作を持たない読み取り専用の監視ダッシュボードのため、
 * 独自DBでのセッション永続化・8時間絶対タイムアウト・reauthは実装せず、
 * Supabase自身が管理するJWTセッション + 許可リスト判定のみで完結させる。
 */
export async function getSession(): Promise<Session | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.email || !isEmailAllowed(claims.email)) return null;

  const name =
    (claims.user_metadata?.full_name as string | undefined) ??
    (claims.user_metadata?.name as string | undefined) ??
    null;
  const image = (claims.user_metadata?.avatar_url as string | undefined) ?? null;

  return {
    user: {
      email: claims.email,
      name,
      image,
    },
  };
}

/** ページ（Server Component）用。未認証なら /login へリダイレクトする。 */
export async function requireSessionForPage(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

/** APIルート用。未認証なら401を返す（呼び出し側で return してレスポンスとして使う）。 */
export async function requireSessionForApi(): Promise<
  { session: Session; response?: undefined } | { session?: undefined; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      response: NextResponse.json({ error: "認証が必要です" }, { status: 401 }),
    };
  }
  return { session };
}

/** 認証を通した呼び出し元。画面からのアクセスか、サーバー間のトークンかを区別する。 */
export type ApiCaller = { kind: "session"; session: Session } | { kind: "token" };

/**
 * 受け取った文字列が期待値と一致するかを、実行時間から情報が漏れにくい形で判定する。
 *
 * `timingSafeEqual` は長さが違うとその場で例外を投げるため、素で渡すと「長さが合っているか」
 * だけを応答時間・エラーの有無から切り分けられてしまう。先にSHA-256で固定長（32バイト）へ
 * 畳んでおくことで、長さが違っても同じ経路を通り、期待値の長さを推測させない。
 */
function tokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * 読み取りAPIルート用。ログインセッションか、サーバー間用の固定トークンのどちらかを求める。
 *
 * 画面からの利用はこれまでどおりログインセッションで通る。加えて、同一VPS上で動くAIDEの
 * MCPサーバー（guchi-apps/aide#31）がログイン画面を通れないため、`OPS_API_TOKEN` を
 * `Authorization: Bearer` で照合する経路を併設している。`OPS_API_TOKEN` が未設定なら
 * トークン経路は常に不可となり、セッション必須だったこれまでの挙動と変わらない。
 *
 * このヘルパーを使うパスは src/proxy.ts の認証対象から除外している。除外されたパスの保護は
 * ここ一箇所に集約されるため、**同じディレクトリへルート（特にGET以外）を足すときは
 * 必ず認証を通すこと**。付け忘れるとそのまま無認証で公開される。
 */
export async function requireSessionOrApiToken(
  request: Request,
): Promise<
  { caller: ApiCaller; response?: undefined } | { caller?: undefined; response: NextResponse }
> {
  const session = await getSession();
  if (session) return { caller: { kind: "session", session } };

  const apiToken = process.env.OPS_API_TOKEN;
  const authorization = request.headers.get("authorization");
  if (apiToken && authorization?.startsWith("Bearer ")) {
    if (tokenMatches(authorization.slice("Bearer ".length), apiToken)) {
      return { caller: { kind: "token" } };
    }
  }

  return {
    response: NextResponse.json({ error: "認証が必要です" }, { status: 401 }),
  };
}
