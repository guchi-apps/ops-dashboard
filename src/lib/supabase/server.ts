import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Server Component / Route Handler / Server Action 共通の Supabase クライアント。
 * Server Component からは Cookie を書き込めないため、そこでの setAll 失敗は無視する
 * （アクセストークンの実際のリフレッシュは src/proxy.ts が担う）。
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component から呼ばれた場合は Cookie を書き込めない。
          }
        },
      },
    },
  );
}
