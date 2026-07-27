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

### スマホなど同一LAN上の別端末から確認する

Next.js 16 では `next dev` のデフォルトホストが `0.0.0.0` のため、`npm run dev` を実行するだけでLAN内の他端末からアクセスできる状態になる（追加のCLIオプションは不要）。

WSL2はNAT構成のため、Windowsホスト側でWSLへのポートフォワーディングとファイアウォール許可が必要（このマシンでは他プロジェクト用に設定済みのため、通常は以下の確認だけで動く）。

1. WSL側でIPを確認する: `ip addr show eth0 | grep inet`
2. Windows側（PowerShell、管理者権限）でポートフォワーディングを設定・更新する（WSLは再起動のたびにIPが変わるため、変わった場合はここを再実行する）
   ```powershell
   netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0
   netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSLのIP>
   ```
3. Windowsファイアウォールで TCP 3000 の受信を許可する（他プロジェクトで許可済みなら不要）
   ```powershell
   New-NetFirewallRule -DisplayName "WSL ops-dashboard Dev 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
4. スマホなど同一Wi-FiにいるほかのデバイスからWindowsのLAN IP（`ipconfig`の「IPv4 アドレス」）にアクセスする: `http://<WindowsのLAN IP>:3000`

**Googleログインを試す場合の注意**: `http://<WindowsのLAN IP>:3000` のように生のIPアドレスのままでは**Googleログインが必ず失敗する**。SupabaseのAuth（GoTrue）は `redirect_to` のホスト名が生のIPアドレスの場合、ループバック（`127.0.0.1`）以外は許可リストの設定に関わらず無条件で拒否する実装になっているため（[internal/utilities/request.go](https://github.com/supabase/auth/blob/master/internal/utilities/request.go)）。

回避策として、[sslip.io](https://sslip.io) のようなワイルドカードDNS（`<IP>.sslip.io` がそのIPに解決される）でIPアドレスをホスト名に変換してアクセスする。

1. Supabaseダッシュボードの Authentication → URL Configuration → Redirect URLs に `http://<WindowsのLAN IP>.sslip.io:3000/auth/callback` を追加登録する（**完全一致のURLのみ登録すること**。`http://<WindowsのLAN IP>.sslip.io:*/**` のようなポート部分をワイルドカードにしたパターンを混ぜると、Redirect URLs許可リスト全体の反映が壊れ、完全一致の行も含めて効かなくなる現象を確認済み）
2. スマホからは `http://<WindowsのLAN IP>:3000` ではなく `http://<WindowsのLAN IP>.sslip.io:3000` でアクセスする

## テスト

```bash
npm run lint
npm run build
```

## デプロイ

`admin.gucchii.com`（VPS上、PM2プロセス名 `ops-dashboard`、ポート3110）で公開する。

- **CI**: `.github/workflows/ci.yml`。`develop`へのpushと`main`/`develop`へのPRでlint・型チェック・buildを実行
- **デプロイ**: `.github/workflows/deploy.yml`。`main`へのpushで、`package.json`のversionからGitタグ・GitHub Releaseを作成し、ビルド成果物をVPSへ配置してPM2で再起動する（`deploy/ecosystem.config.js`）
- **シークレット**: 1Password（`apps`ボールト、`op://apps/ops-dashboard/...`）を`.github/deploy.env.tpl` / `.github/ci.env.tpl`経由で参照。GitHub Secretsには`OP_SERVICE_ACCOUNT_TOKEN`のみ登録する
- **Apache**: リバースプロキシ設定は`vps`リポジトリ（`apache/sites-available/admin.gucchii.com.conf`）が一次情報源。`deploy/apache-vhost.example.conf`は参考用の雛形
- **Supabase**: Authentication → URL Configuration の Redirect URLs に `https://admin.gucchii.com/auth/callback` を追加登録すること
