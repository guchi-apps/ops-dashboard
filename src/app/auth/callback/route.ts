import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getStatusHubAccess } from "@/lib/access/status-hub";
import { sanitizeReturnTo } from "@/lib/return-to";
import { getRequestOrigin } from "@/lib/request-origin";
import { recordAndNotifyLogin } from "@/lib/login-notify";
import { signOutLocally } from "@/lib/supabase/sign-out";

export const dynamic = "force-dynamic";

/** Supabase の Google OAuth コールバック。 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = await getRequestOrigin();
  const code = searchParams.get("code");
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (
    !claims?.email ||
    claims.user_metadata?.email_verified === false ||
    !getStatusHubAccess(claims.email).allowed
  ) {
    // 許可外ユーザーでも、共有 Supabase 上の他アプリのセッションは失効させない。
    await signOutLocally(supabase);
    return NextResponse.redirect(`${origin}/login?error=forbidden`);
  }

  // 接続元IP・User-Agent は recordAndNotifyLogin がリクエストヘッダーから拾う
  await recordAndNotifyLogin({ email: claims.email });

  return NextResponse.redirect(`${origin}${returnTo}`);
}
