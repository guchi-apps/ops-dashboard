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
