import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/allowed-emails";
import { sanitizeReturnTo } from "@/lib/return-to";
import { getRequestOrigin } from "@/lib/request-origin";
import { notifySignalyLogin } from "@/lib/signaly";

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

  if (!claims?.email || !isEmailAllowed(claims.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=forbidden`);
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip");
  await notifySignalyLogin(ip);

  return NextResponse.redirect(`${origin}${returnTo}`);
}
