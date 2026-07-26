import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/request-origin";

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const origin = await getRequestOrigin();
  return NextResponse.redirect(`${origin}/login`);
}
