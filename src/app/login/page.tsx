import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/request-origin";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "このGoogleアカウントには利用が許可されていません。",
  signin_failed: "ログインに失敗しました。もう一度お試しください。",
  missing_code: "ログインに失敗しました。もう一度お試しください。",
  exchange_failed: "ログインに失敗しました。もう一度お試しください。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? "ログインに失敗しました。") : null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">ops-dashboard</h1>
        <p className="text-muted-foreground text-sm">
          許可されたGoogleアカウントでログインしてください
        </p>
      </div>
      {errorMessage && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}
      <form
        action={async () => {
          "use server";
          const origin = await getRequestOrigin();
          const supabase = await createClient();
          const { data, error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: `${origin}/auth/callback` },
          });
          if (error || !data.url) {
            redirect("/login?error=signin_failed");
          }
          redirect(data.url);
        }}
      >
        <Button type="submit" size="lg" className="min-h-11 px-6">
          Googleでログイン
        </Button>
      </form>
    </div>
  );
}
