import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// /auth 配下（callback・signout）は未ログイン状態で叩かれても安全なため素通りさせる。
// /api/claude-usage はScriptableのウィジェットから叩く中継APIで、ログイン画面を通れないため
// ここでは素通りさせ、ルート側で WIDGET_TOKEN による認証を行う。
// /api/host-stats はサブPCのエージェントがメトリクスをPOSTする受け口で、同じくログイン画面を
// 通れないため素通りさせ、ルート側で HOST_STATS_TOKEN による認証を行う。
// 残りの読み取りAPIは、同一VPS上のAIDE（MCPサーバー）から参照するために素通りさせ、ルート側の
// requireSessionOrApiToken() でログインセッションまたは OPS_API_TOKEN による認証を行う。
//
// **ここに載せたパスの保護はルート側だけが担う。** 以下のディレクトリへルート（特にGET以外の
// メソッド）を足すときは、必ずルート側で認証すること。付け忘れるとそのまま無認証で公開される。
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/auth",
  "/api/claude-usage",
  "/api/host-stats",
  "/api/monitors",
  "/api/uptime-kuma",
  "/api/ai-usage",
  "/api/github-usage",
  "/api/onepassword-usage",
];

/**
 * リクエストごとに Supabase のアクセストークンをリフレッシュし、更新後のCookieを
 * レスポンスに書き戻す。Server Component は Cookie を書き込めないため、この処理が
 * ないとアクセストークン（デフォルト有効期限1時間）失効後にリフレッシュトークンが
 * 有効でもセッションが切れて見えてしまう。
 *
 * ここでの認証チェックは楽観的なもの（Next.js公式ドキュメントの "optimistic checks"）
 * であり、許可リスト判定などの本格的な検証は各ページ/APIルートから呼ばれる
 * src/lib/session.ts 側で行う。
 */
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // createServerClient と getClaims() の間に他のロジックを挟まない
  // （トークンリフレッシュが getClaims() 呼び出しの副作用として行われるため）。
  const { data } = await supabase.auth.getClaims();

  const { pathname } = request.nextUrl;
  if (!data && !PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
    }
    // request.url はリバースプロキシ配下だと内部アドレス（localhost:PORT）を
    // 指すことがあるため、Host + X-Forwarded-Proto から組み立てる。
    const host = request.headers.get("host");
    const protocol = request.headers.get("x-forwarded-proto") ?? "http";
    return NextResponse.redirect(`${protocol}://${host}/login`);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
