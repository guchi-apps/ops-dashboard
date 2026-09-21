import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/request-origin";
import { signOutLocally } from "@/lib/supabase/sign-out";

export async function POST() {
  const supabase = await createClient();
  // 共有 Supabase 上の他アプリ・他端末のセッションを巻き込まないよう local scope で破棄する。
  await signOutLocally(supabase);
  const origin = await getRequestOrigin();
  return NextResponse.redirect(`${origin}/login`);
}
