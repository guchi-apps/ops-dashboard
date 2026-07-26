# ops-dashboard

VPS稼働状況・UptimeRobot・Uptime Kuma監視ダッシュボード。Next.js App Router + Supabase Auth（Google認証）で構成。
経緯は [portfolio issue #65](https://github.com/m-guchi/portfolio/issues/65) を参照。

ログインには Supabase プロジェクト（`db-console`と共通、Google Provider を有効化したもの）が必要。
`.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `ALLOWED_EMAILS` を設定し、
Supabaseダッシュボードの Authentication → URL Configuration の Redirect URLs に
`http://localhost:3000/auth/callback`（本番は `https://<ドメイン>/auth/callback`）を登録すること。

`db-console`と異なり、破壊的操作を持たない読み取り専用の監視表示のみのため、独自DBでのセッション管理（監査ログ・8時間絶対タイムアウト・reauth）は実装せず、Supabase自身が管理するセッション + 許可リスト判定のみで認証を完結させている。

## セットアップ

```bash
npm install
npm run env:init   # .env.local を作成（値を編集）
npm run dev
```

[http://localhost:3000](http://localhost:3000) で確認できる。

## テスト

```bash
npm run lint
npm run build
```

## デプロイ

未整備（issue #65のロードマップ④）。VPS Apacheリバースプロキシ設定・1Passwordアイテム・GitHub Actions CI/CDは今後整備する。
