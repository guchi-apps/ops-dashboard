/** `signOutLocally` が必要とする Supabase クライアントの最小の形（scope は local だけを受け付ける）。 */
export type LocalSignOutClient = {
  auth: {
    signOut(options: { scope: "local" }): Promise<unknown>;
  };
};

/**
 * このアプリのセッションだけを破棄する（Cookie を消し、この端末のリフレッシュトークンを失効させる）。
 *
 * **`signOut()` を引数なしで呼んではいけない。** Supabase Auth の既定 scope は `global` で、
 * 同じユーザーの全セッション（共有 Supabase プロジェクトを使う他アプリ・他端末）の
 * リフレッシュトークンまで失効させる。ログアウトのたびに他アプリのログインが外れてしまう
 * （guchi-apps/issue-deck#3235・#320）。このアプリからのログアウトと、許可外ユーザーの
 * セッション破棄は、必ずこの関数を通す。
 */
export async function signOutLocally(supabase: LocalSignOutClient): Promise<void> {
  await supabase.auth.signOut({ scope: "local" });
}
