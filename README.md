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

## ホスト（VPS・サブPC）のステータス表示

VPSと自宅LAN内のサブPCについて、CPU・メモリ・ディスク等の現在値と直近24時間の推移をホストごとに表示する（[issue #34](https://github.com/m-guchi/ops-dashboard/issues/34)）。

収集は**すべて push 型に一本化**している。サブPCは自宅LAN内（NAT配下）にいてVPSからポーリングできないため、ホスト側から定期的にPOSTしてもらう必要があり、VPSだけ別方式にすると同じ表示を二重に実装することになるためである。
VPS上ではダッシュボード自身が同じマシンで動いているので、送信先は `http://localhost:3110`（外部を経由しない）。

```
各ホスト（VPS・サブPC）                        ダッシュボード（admin.gucchii.com）
  systemd timer（1分ごと）
    └─ scripts/host-stats/agent.sh
         /proc・df・systemctl から収集
         → POST /api/host-stats（Bearer HOST_STATS_TOKEN）
                                                 └─ .data/host-stats/<識別子>/latest.json
                                                    .data/host-stats/<識別子>/history.jsonl
                                                    → ダッシュボードがGETしてホストごとに描画
```

ホストは `HOST_STATS_ID` で識別し、保存先はその単位で分かれる。台数が増えてもダッシュボード側の変更は不要で、
エージェントを設置してPOSTが届いた時点でセクションが増える（一度も受信していないホストは表示されない）。

Prometheus + Grafana は、VPSがメモリ2GBでNext.jsを10本抱えている（[deploy/ecosystem.config.js](deploy/ecosystem.config.js) 参照）現状では常駐分だけで数百MBを要して載せられないため採用していない。
履歴はJSONL 1行=1サンプル（1分間隔・24時間で約1,400行）で持ち、グラフはインラインSVGのスパークラインとして描いている（チャートライブラリは追加していない）。

**トレードオフ**: 表示値は最大で送信間隔（既定1分）ぶん古い。またエージェントが止まると値の更新も止まるが、これは OFFLINE 表示で判別できる。

### 表示する項目

| 項目 | 取得元 | 備考 |
| --- | --- | --- |
| CPU使用率 | `/proc/stat` を1秒あけて2回読む | |
| メモリ使用率 | `/proc/meminfo`（MemTotal - MemAvailable） | |
| Swap使用率 | `/proc/meminfo` | SwapTotal が0なら送らず、カードも出ない |
| ディスク使用率 | `df -B1 -P <パス>` | 複数パス指定可。カードとグラフは最も使用率が高い1件、残りは下に一覧で出す |
| Load Average | `/proc/loadavg` | |
| ネットワーク転送量 | `/proc/net/dev` の差分 | `lo` と仮想NIC（docker・veth 等）は除いた合計 |
| ディスクI/O | `/proc/diskstats` の差分 | パーティション・ループバックを除く物理デバイスの合計 |
| 稼働時間 | `/proc/uptime` | |
| CPU温度 | `/sys/class/thermal/thermal_zone*` | 取れないマシンではカードごと省かれる |
| CPU上位プロセス | `ps -eo pcpu=,args=` | 上位3件。カーネルスレッドは除く |
| サービス死活 | `systemctl is-active <名前>` | 指定したサービスをバッジで表示 |
| 再起動待ち | `/var/run/reboot-required` の有無 | Debian系のみ |
| 未適用の更新 | `/var/lib/update-notifier/updates-available` | `update-notifier-common` が入っていれば表示される。ESM（有償の延長サポート）分は数えない |
| ログイン中のセッション | `who` | セッション数とユーザー名 |
| オフライン判定 | 最終受信からの経過時間 | 既定5分で OFFLINE 表示（値は最後に受信したものを残す） |

差分から求める3項目（CPU・ネットワーク・ディスクI/O）は、前回値をファイルに残さずに済ませるため、1回の実行内で1秒あけて2回読んだ差を使っている。

更新件数は `/usr/lib/update-notifier/apt-check` でも取れるが、1回あたり1.5秒ほどCPUを使う一方で値は1日に数回しか変わらないため、update-notifier が書き出したファイルを読むだけにしている。

グラフに残す履歴はCPU・メモリ・ディスク・Load・Swap・温度・ネットワーク・ディスクI/Oで、24時間を超えた行は送信のたびに掃除する。
1,440点をそのまま返すとレスポンスが太るため、APIは最大180点へ間引いてから返す。

### ダッシュボード側の設定

`HOST_STATS_TOKEN` を設定するだけでよい（未設定の場合、受信は常に401になる）。
本番では1Passwordの `apps/ops-dashboard` アイテムに `host-stats-token` フィールドを追加しておく（未作成のままだとデプロイのシークレット読み込みが失敗する）。

並び順は `HOST_STATS_ORDER`（識別子をカンマ区切り、デプロイ時に `vps` を指定している）、オフライン判定のしきい値と履歴の長さは `HOST_STATS_OFFLINE_AFTER_SECONDS` / `HOST_STATS_HISTORY_HOURS` で変えられる。

### 各ホストへのエージェント設置

`scripts/host-stats/` の3ファイルを配置する。エージェントはbashとcurlだけで動き、常駐しない（1分ごとに起動して終了する短命プロセス）。VPS・サブPCとも手順は同じで、設定ファイルの中身だけが違う。

**VPSでは管理者アカウントで作業すること。** デプロイ先（`~/apps/admin`）の所有者である `github-user` は
sudo が `apply.sh` のみに制限されており、`/opt` や `/etc` への配置ができない。
ファイルの読み取りは root で行われるため、配置元にデプロイ先のパスをそのまま指定してよい。

```bash
# VPSの場合。デプロイ先から配る（サブPCではリポジトリをcloneした場所を指す）
SRC=/home/github-user/apps/admin/scripts/host-stats

# 1. エージェントを配置する
sudo mkdir -p /opt/ops-dashboard-host-stats
sudo cp "$SRC/agent.sh" /opt/ops-dashboard-host-stats/
sudo chmod 755 /opt/ops-dashboard-host-stats/agent.sh

# 2. 設定ファイルを新規に作る（トークンを含むため 600 / root 所有にする）
#    VPS なら host-stats.vps.env.example、サブPC なら host-stats.subpc.env.example を使う
sudo cp "$SRC/host-stats.vps.env.example" /etc/ops-dashboard-host-stats.env
sudo chmod 600 /etc/ops-dashboard-host-stats.env
# エディタを開く行なので、ここまでをまとめて貼り付けないこと
# （後続の行が vi への入力として流し込まれ、設定ファイルが壊れる）
sudo vi /etc/ops-dashboard-host-stats.env   # HOST_STATS_TOKEN を記入（他の項目は雛形のままでよい）

# 3. 送信されるJSONを確認する（送信はしない）
#    設定ファイルは600/root所有のため、読み込みごとrootで行う
sudo bash -c 'set -a; . /etc/ops-dashboard-host-stats.env; set +a; /opt/ops-dashboard-host-stats/agent.sh --print'

# 4. systemd timer を有効化する
sudo cp "$SRC"/ops-dashboard-host-stats.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ops-dashboard-host-stats.timer

# 5. 1回手動で走らせて結果を見る
sudo systemctl start ops-dashboard-host-stats.service
systemctl status ops-dashboard-host-stats.service
```

`/etc/ops-dashboard-host-stats.env` は各ホストで新規に作るファイルで、Gitでもデプロイでも管理していない。
アプリ本体の `.env`（デプロイのたびに書き換わり、全シークレットを含む）とは意図的に分けている。

### 監視するサービスの選び方

`HOST_STATS_SERVICES` に書くのは表示用の名前ではなく、そのホストに実在する systemd ユニット名で、
`systemctl is-active <名前>` にそのまま渡る（存在しない名前を書くと、常に `inactive` の赤バッジが出るだけ）。
候補は `systemctl list-units --type=service --state=running` で確認する。

**Uptime Kuma の HTTP 監視と重複しないものだけを選ぶ**方針にしている。Uptime Kuma は「外から応答があるか」、
systemd は「そのホストでプロセスが動いているか」を見るもので、HTTPの口を持たないもの（cron・fail2ban・DB）は
後者でしか分からない。逆に、各Next.jsアプリや signaly のようにUptime Kumaが直接見ているものを入れても重複にしかならない。
選定結果は `scripts/host-stats/host-stats.*.env.example` に理由つきで書いてある。

なお次の2つは user systemd（`github-user`）で動いており、rootの `systemctl` からは見えないため、
エージェントではなく Uptime Kuma 側にHTTPモニターとして追加する。トークン認証で401が返る場合は、
Kumaの Accepted Status Codes に `401` を足せば「起動していればup・落ちていれば接続不能でdown」を判定できる。

| サービス | エンドポイント |
| --- | --- |
| `vps-status-api` | `https://gucchii.com/internal/vps-status` |
| `uptime-kuma-backup-receiver` | `https://gucchii.com/internal/uptime-kuma-backup` |

送信間隔を変えるときは `ops-dashboard-host-stats.timer` の `OnUnitActiveSec` を変更する。
間隔を `HOST_STATS_OFFLINE_AFTER_SECONDS`（既定300秒）より長くすると常時OFFLINE表示になるため、合わせて調整すること。

### 受信APIの仕様

```
POST /api/host-stats
Authorization: Bearer <HOST_STATS_TOKEN>
Content-Type: application/json
```

| コード | 条件 |
| --- | --- |
| 200 | 受信・保存に成功（`{"ok":true,"receivedAt":"..."}` を返す） |
| 400 | JSONとして読めない、必須項目が欠けている、`version` が非対応、`id` が使えない文字を含む |
| 401 | `Authorization` が一致しない、または `HOST_STATS_TOKEN` 未設定 |
| 413 | ペイロードが32KBを超えている |

ペイロードの形式は `src/types/host-stats.ts` の `HostStatsReport`。`version` で世代を管理しており、
エージェント側を非互換に変える場合は `HOST_STATS_PAYLOAD_VERSION`（`src/lib/host-stats/report.ts`）を上げる。
`id` は保存先のディレクトリ名になるため、英小文字・数字・ハイフン・アンダースコアのみ受け付ける。
ダッシュボードからの取得（GET）は通常どおりログインセッションで認証する。

## AI使用状況の表示

Claude / ChatGPT のトークン使用状況と課金プランをダッシュボードに表示する。

いずれの提供元も「サブスクリプション（Max / Plus 等）の残枠」を返す公開APIを用意していないため、
各CLIが内部的に使っている非公開のエンドポイントを、VPS側に保管したOAuthトークンで叩いている。
**公式に文書化されたAPIではないため、提供元の仕様変更で取得できなくなる可能性がある**点に注意する。

| 提供元 | 取得元 | 表示できるもの |
| --- | --- | --- |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` と `/api/oauth/profile`（Claude Code の `/usage` と同じ） | 5時間・週間の使用率とリセット時刻、追加利用クレジットの課金額、プラン名（`rate_limit_tier` から判定） |
| ChatGPT | `GET https://chatgpt.com/backend-api/wham/usage`（Codex CLI の `/status` と同じ） | 5時間・週間の使用率とリセット時刻、プラン名（APIが返す `plan_type`） |

プラン名はどちらもAPIから自動取得するため設定不要。`CLAUDE_PLAN_NAME` / `CHATGPT_PLAN_NAME` を設定した場合のみ、表示名の上書きとして使われる。

Gemini（Antigravity）は使用状況の確認手段がインタラクティブなTUI（`/usage`）だけで、
非対話の出力もHTTP APIも公開されておらず取得できないため、表示対象に含めていない。

### 認証情報の取得方法

OAuthのリフレッシュトークンは使うたびにローテーションするため、**日常的に使っているCLIのログイン情報を
そのまま流用してはいけない**。ダッシュボードが更新するたびにCLI側の値が古くなり、ログアウトさせられる。
どちらもダッシュボード専用のログインを別途作り、そのトークンだけを渡す。

同じ理由で、**ローカル開発（`.env.local`）と本番（1Password）で同じトークンを共有してもいけない**。
先にローカルで動かすとその時点でトークンがローテーションし、1Passwordに登録した値は失効する。
ローカルで確認したい場合は、本番用とは別にもう一度ログインして別のトークンを使うこと。

- **Claude**: 設定ディレクトリを分けてログインすると、普段のログインに影響しない独立したトークンが得られる。

  ```bash
  CLAUDE_CONFIG_DIR=~/.claude-ops-dashboard claude auth login
  python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude-ops-dashboard/.credentials.json')))['claudeAiOauth']['refreshToken'])"
  ```

  出力を `ANTHROPIC_OAUTH_REFRESH_TOKEN` に設定する。以降このディレクトリで `claude` を**実行しない**こと
  （トークンがローテーションし、ダッシュボード側の値が古くなるため）。

  なお `claude setup-token` で発行した長期トークン（`sk-ant-oat01-...`）は**使えない**。発行時に `user:inference`
  スコープしか要求されず、このエンドポイントが必要とする `user:profile` が付かないため 403 になる
  （[claude-code#22450](https://github.com/anthropics/claude-code/issues/22450)）。

- **ChatGPT**: 同様に `CODEX_HOME` で設定ディレクトリを分けてログインする（`CODEX_HOME` は
  **存在するディレクトリを指していないとエラーになる**ため、先に作成しておくこと）。

  ```bash
  mkdir -p ~/.codex-ops-dashboard
  CODEX_HOME=~/.codex-ops-dashboard codex login --device-auth
  python3 -c "import json,os;t=json.load(open(os.path.expanduser('~/.codex-ops-dashboard/auth.json')))['tokens'];print(t['refresh_token']);print(t['account_id'])"
  ```

  1行目を `OPENAI_CHATGPT_REFRESH_TOKEN`、2行目を `OPENAI_CHATGPT_ACCOUNT_ID` に設定する。
  Claude と同様、以降このディレクトリで `codex` を実行しないこと。

  ただし **snap 版の codex は `CODEX_HOME` を無視し**、常に `~/snap/codex/<リビジョン>/auth.json` を使う
  （`snap run` が環境変数を落とすため）。この開発マシンでは普段使いの Codex が `~/.codex` を使っているので、
  snap 版でログインしたものをそのままダッシュボード専用の認証情報として使っている。

リフレッシュトークンは使うたびにローテーションするため、更新後の値を `.data/ai-usage-tokens.json`
（`AI_USAGE_STATE_PATH` で変更可）に保存して引き継ぐ。このディレクトリはデプロイ時の削除対象外のため、
デプロイをまたいでも失効しない。環境変数側のトークンを差し替えた場合は、保存済みの値を破棄して再取得する。

各提供元のエンドポイントはレート制限が厳しい（Anthropic側は180秒以上の間隔が推奨）ため、
取得結果はサーバー側で既定5分間キャッシュする（`AI_USAGE_CACHE_SECONDS` で変更可）。

## iPhoneウィジェット向けのClaude利用枠API

iPhoneのロック画面ウィジェット（Scriptable）からClaudeの利用枠の残量を参照するための中継API。
ダッシュボードには表示せず、このエンドポイントだけを提供する。

```
GET /api/claude-usage
Authorization: Bearer <WIDGET_TOKEN>
```

上流（`https://api.anthropic.com/api/oauth/usage`）のJSONに `collected_at`（取得時刻）と
`stale`（古いキャッシュを返しているか）を足して返す。キー構成は提供元の都合で変わりうるため、
サーバー側では解釈し直さずそのまま素通しし、ウィジェット側が知っているキーだけを読む。

```json
{
  "five_hour": { "utilization": 0.42, "resets_at": "2026-08-12T17:00:00Z" },
  "seven_day": { "utilization": 0.61, "resets_at": "2026-08-14T03:00:00Z" },
  "collected_at": "2026-08-12T14:05:00Z",
  "stale": false
}
```

| コード | 条件 |
| --- | --- |
| 200 | 取得成功、またはキャッシュあり（失敗時は `stale: true` と `error` が付く） |
| 401 | `Authorization` が一致しない、または `WIDGET_TOKEN` 未設定 |
| 503 | 上流の取得に失敗し、キャッシュも無い |

- **認証**: Scriptableはログイン画面を通れないため、Supabase Authではなく `WIDGET_TOKEN` との完全一致で認証する。
  このパスは `src/proxy.ts` の認証対象から除外している。`WIDGET_TOKEN` が未設定なら常に401を返す
- **認証情報**: AI使用状況の表示と同じ `ANTHROPIC_OAUTH_REFRESH_TOKEN` を使う。
  issueの当初案は同一VPS上の `~/.claude/.credentials.json` を直接読む方式だったが、
  このファイルは 600 でpm2の実行ユーザーを揃える必要があるうえ、アクセストークンの更新を
  そのマシンのClaude Codeの実行に依存してしまうため、既存の仕組み（リフレッシュトークン + トークンストア）に寄せている
- **キャッシュ**: プロセス内メモリに10分保持する（永続化しない）。上流の取得に失敗しても、
  キャッシュがあれば `stale: true` を付けて200で返し、ウィジェットが空になることを避ける
- **タイムアウト**: ウィジェット側のタイムアウトが8秒のため、上流の呼び出しは8秒で打ち切る

`anthropic-beta` ヘッダーのバージョン文字列が変わると**無言で401になる**。値は
`src/lib/ai-usage/claude.ts` の `OAUTH_BETA_VERSION` にまとめてあるので、そこを書き換えれば復旧できる。

## GitHubの制限の表示

`guchi-apps` organization のGitHub Actions無料枠の消費量と、REST APIのレート制限をダッシュボードに表示する。

| 表示 | 取得元 |
| --- | --- |
| Actions無料枠の消費量・今月の総実行時間・リポジトリ別の内訳・課金額 | `GET /organizations/{org}/settings/billing/usage` |
| APIレート制限（5,000 req/時）の残量とリセット時刻 | `GET /rate_limit` |
| 無料枠を消費するリポジトリの判定 | `GET /orgs/{org}/repos?type=private` |

**publicリポジトリのActionsは無制限に無料**のため、無料枠（Freeプランは2,000分/月）を消費するのは
privateリポジトリの分だけである。課金レポートはpublicリポジトリの実行時間も含めて返すので、
合計をそのまま無料枠と比べると実際よりはるかに消費しているように見えてしまう。
このため無料枠のゲージはprivateリポジトリ分のみで計算し、総実行時間は別項目として表示している
（無料枠の消費は実行環境ごとの倍率も加味する。Windowsは2倍、macOSは10倍）。

Actionsのストレージ消費は課金レポートがGB時間で返す一方、無料枠は容量（500MB）で決まっているため
割合を出せない。実績値のみを表示している。

### 実装上の注意

- **課金レポートは `year` / `month` を必ず指定する**。省略すると全リポジトリの合計が単一のリポジトリ名に
  束ねられた状態で返るため、リポジトリ別の内訳が出せない
- 旧エンドポイント `GET /orgs/{org}/settings/billing/actions`（`included_minutes` などを返していた）は
  410で廃止済み。現在は無料枠の残量を直接返すAPIが存在しないため、上記の方法で自前に算出している
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing` は、public・privateいずれのリポジトリでも
  `billable` が常に0を返す状態で、実行時間の取得には使えない

### 認証情報の取得方法

課金レポートのエンドポイントはfine-grained PATに非対応のため、**classic PAT**を使う。
必要なスコープは `read:org` と、privateリポジトリの一覧取得に使う `repo`。
発行した値を `GH_USAGE_TOKEN`、対象の組織名を `GH_USAGE_ORG` に設定する。
どちらか未設定の場合はGitHubセクションを表示しない。

取得結果はサーバー側で既定5分間キャッシュする（`GH_USAGE_CACHE_SECONDS` で変更可）。
無料枠の上限は `GH_ACTIONS_MINUTES_LIMIT` で上書きできる（未設定時は2,000分）。

### Notionを表示対象に含めていない理由

Notionは使用量・プラン枠を返すAPIを公開しておらず、レート制限（平均3 req/秒）も残量ヘッダを返さず
429と `Retry-After` のみで通知される仕様のため、「残り何%」に相当する値が取得できない。
1クエリ10,000件のページング上限やペイロード上限（1,000ブロック / 500KB）も時間でリセットされる枠ではなく、
ダッシュボードの残量表示には載らないため対象外としている（Geminiと同じ扱い）。

## テスト

```bash
npm run lint
npm run build
```

## デプロイ

`admin.gucchii.com`（VPS上、PM2プロセス名 `ops-dashboard`、ポート3110）で公開する。

- **CI**: `.github/workflows/ci.yml`。`develop`へのpushと`main`/`develop`へのPRでlint・型チェック・buildを実行
- **デプロイ**: `.github/workflows/deploy.yml`。`main`へのpushで、`package.json`のversionからGitタグ・GitHub Releaseを作成し、ビルド成果物をVPSへ配置してPM2で再起動する（`deploy/ecosystem.config.js`）
- **シークレット**: 1Password（`apps`ボールト、`op://apps/ops-dashboard/...`）を`.github/deploy.env.tpl` / `.github/ci.env.tpl`経由で参照。GitHub Secretsには`OP_SERVICE_ACCOUNT_TOKEN`のみ登録する。AI使用状況の表示を有効にするには、`apps/ops-dashboard`アイテムに`anthropic-oauth-refresh-token` / `openai-chatgpt-refresh-token` / `openai-chatgpt-account-id`のフィールドを追加しておく。GitHubの制限の表示には`github-usage-token` / `github-usage-org`のフィールドを追加しておく。iPhoneウィジェット向けAPIには`widget-token`のフィールド（32文字以上のランダム文字列）を追加しておく（いずれも未作成のままだとデプロイのシークレット読み込みが失敗する）
- **Apache**: リバースプロキシ設定は`vps`リポジトリ（`apache/sites-available/admin.gucchii.com.conf`）が一次情報源。`deploy/apache-vhost.example.conf`は参考用の雛形
- **Supabase**: Authentication → URL Configuration の Redirect URLs に `https://admin.gucchii.com/auth/callback` を追加登録すること
