<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# ops-dashboard — エージェント向けガイド

自宅VPS・サブPC・AI利用枠などの状態を1画面で見るための個人向けダッシュボード。技術スタックと
セットアップ手順は [README.md](./README.md) を参照する。ここにはエージェント（Claude Code）が守る
運用ルールと、READMEに書かれていない判断基準だけを書く。

**GitHub Actions 上での無人実行は、このリポジトリをチェックアウトしたワークツリーしか参照できない。**
ローカル実行ではユーザー個人環境のグローバルルール（`~/.claude/CLAUDE.md`）も読み込まれるが、
無人実行では読み込まれない。したがって無人実行でも守られる必要があるルールは、このファイルに
明文化しておく必要がある。

## 検証コマンド

**このリポジトリには `test`・`typecheck` の npm script が無い。** CI（`.github/workflows/ci.yml`）は
下記の3つを実行している。**存在しないコマンドを探さず、下記を使うこと。**

| 目的 | コマンド |
|---|---|
| Lint | `npm run lint` |
| 型チェック | `npx tsc --noEmit` |
| ビルド | `npm run build` |

`npm run build` はラッパーを通さないため無人実行から使える。DBは使わない（`prisma/` を持たない）ので、
マイグレーションやシードの手順は無い。

### 開発サーバーでの画面確認

**`/login` 配下以外の全ページはログイン必須**（`src/proxy.ts` の `PUBLIC_PATH_PREFIXES`）で、
Supabaseのセッションが無いと `/login` へリダイレクトされる。`.env.local` が無いworktree
（GUIが無くOAuthを完了できない環境を含む）では、素の `curl` で画面を確認できない。

**`public/` 配下の静的ファイルも proxy を通る。** Next.js が自動で除外するのは
`_next/static` ・ `_next/image` などだけで、`public/` に置いたファイルは `config.matcher` の
除外か `PUBLIC_PATH_PREFIXES` に載せない限り、未ログインだと `/login` へ307で飛ばされる
（ログイン画面のファビコンが出なくなる。#165）。ログイン画面から参照される静的ファイルを
足すときは `src/proxy.ts` の `config.matcher` の除外に追記する。

ログイン不要な描画だけを確かめたい場合は、`PUBLIC_PATH_PREFIXES` に載っている `/login` 配下へ
**一時的な確認用ルート**（例: `src/app/login/preview-xxx/page.tsx`）を置き、ダミーのSupabase
環境変数を与えて `npm run dev` を起動すれば `curl` で描画結果を取得できる。

`.env.local` が無いworktreeでは、ポートとSupabaseの変数をコマンドに直接渡す。**`src/proxy.ts` が
読むキーは `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** で、`..._ANON_KEY` を渡しても全リクエストが
500になる（値の中身は検証されないのでダミーでよい）。

```bash
PORT=17096 NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=dummy npm run dev
```

レスポンシブの確認は `curl` では見た目まで分からないため、取得したHTMLの `class` に狙った
ユーティリティ（`hidden sm:flex` など）が乗っているかと、`/_next/static/chunks/*.css` にその
クラスが生成されているかで確かめる。
**確認後は必ずそのルートを削除し、`.next` を消してから `npx tsc --noEmit` をやり直す**
（消したルートの型定義が `.next/dev/types/` に残り、存在しないモジュールとして型エラーになる）。

**開発サーバーのPIDは `lsof -ti :<ポート>` ではなく `ss -ltnp` で引く。** `next dev` はIPv6の
`*:<ポート>` で待ち受けており、このホストでは `lsof -ti` が空を返すことがある（#237）。空のまま
止めたつもりになると、動き続けたサーバーが `.next/dev/types/` を書き戻し、上の型エラーが消えない。

```bash
ss -ltnp | grep ':17096 '   # users:(("next-server",pid=…)) のpidだけを kill する
```

ダッシュボード本体（`DashboardShell`）は確認用ルートからでもそのまま描画できる。`DashboardDataProvider`
に `initial={{ uptimeKuma: { monitors: [], error: null }, uptimeRobot: { monitors: [], error: null } }}` を渡せば、実データが無くてもタブの構造まで
HTMLに出るため、レイアウトやクラスの確認はこれで足りる（#136）。

## 監視（Kuma・UptimeRobot）の取得失敗

`fetchUptimeKumaDashboardMonitors` / `fetchUptimeRobotMonitorsServer` は `MonitorFeed`
（`src/lib/monitor-feed.ts`、`{ monitors, error }`）を返す（#276）。**失敗と「モニター0件」を区別するため、
失敗を `[]` で返す形に戻さないこと。** 区別が無いと、Kumaが落ちたとき監視チップが黙って消え、
片方だけ落ちたときは残りの件数で「すべて正常」と出る。

- `error` は画面に出す短い理由（`HTTP 500`・`接続できません`・`応答の形式が想定と異なります`・
  `APIエラー: <type>`）。トークンやURLなど秘匿値を含めない
- **未設定（ベースURL・スラッグ・APIキーが無い）は失敗ではなく `error: null`・0件**。未設定の系統は
  チップにも数えず、worktreeでそのまま動かしてよい
- 失敗はチップ（`monitorChip`）・概要タブの見出しとタイル・監視タブのカードで `danger` として出す。
  片方だけ失敗したときは、チップの値を「一部 取得不可」にして残りの件数は注記へ回す
- `GET /api/uptime-kuma`・`GET /api/monitors` は失敗でも200で `{ monitors: [], error }` を返す。
  `monitors` は残してあるので、それだけを読む呼び出し元（AIDE）は変わらず動く。`error` を見るかは呼び出し元次第

## AIDEの動作状況（AIDEタブ）

AIDEタブは `aide.gucchii.com/status` と同じ内容を、AIDEの `GET /api/status`（guchi-apps/aide#276）から
読んで出している（#237）。**状態はAIDEのプロセス内の値（稼働時間・MCPアクセスの記録・トークン数）から
組み立てられるため、AIDEのデータファイルを直接読む形にはできない。**

- **応答の形の正はAIDE側**（`src/core/views/health.ts` の `Health`）。`src/types/aide-status.ts` はその写しで、
  AIDE側を変えたら合わせ直す。骨格が合わないときは画面ごと落とさず「取得不可」になる（`isStatusPayload`）
- **トークンは `AIDE_STATUS_TOKEN`（AIDE側は `AIDE_STATUS_SECRET`）で、`OPS_API_TOKEN` とは別。**
  `OPS_API_TOKEN` はAIDEがこちらを読む向きのもので、同じ値にすると片方が漏れたときに両方向とも読める。
  AIDEの `AIDE_READ_SECRET` も流用しない（残高のAPIまで読めてしまう）
- 取得に失敗したときのステータスで原因を切り分ける。401はトークンのずれ、503はAIDE側の未設定、
  404はAIDEにAPIがまだ無い（デプロイ前）
- `AIDE_STATUS_TOKEN` が未設定ならタブもチップも出ない。worktreeでそのまま動かしてよい

## Uptime Kuma へのモニター登録

**Uptime Kuma にはモニターを作るREST APIが無い**（1.x・2.x とも）。公開されている
`/api/status-page/*` は読み取り専用で、作成できるのは**管理者としてログインした socket.io
セッションから `add` イベントを送る経路だけ**（v1.23.17 の `server/server.js:643`）。
別のエンドポイントを探さないこと。`src/lib/uptime-kuma-admin.ts` がこの経路を実装している。
公式に約束された仕様ではないので、Kumaを更新したらここが最初に壊れる。

- **`add` だけではダッシュボードに出ない。** この画面はモニターを公開ステータスページ
  （`/api/status-page/<slug>`）から読んでいるため、作成したあと `saveStatusPage` でその
  ページへ載せるところまでやって初めて一覧に並ぶ
- **`saveStatusPage` はグループとモニターの割り当てを丸ごと置き換える。** 送らなかった
  グループは消えるので、いま公開されている `publicGroupList` を読み直し、末尾に1件足したものを
  送り返す。差分だけを送る形にはできない
- **登録は `serialize` で1件ずつ通している**（#278）。「一覧を読む → 足す → 丸ごと保存」なので、
  並行して走ると後から保存した側が先の1件をページから外し、同じURLのモニターも二重に作られる。
  画面の「モニター追加」とサーバー間呼び出しは同じプロセスの同じ関数に入るため、この直列化で足りる
  （PM2を複数プロセスにしたら成り立たない）
- **グループ一覧は公開APIから読むしかない。** 管理者socketの `getStatusPage` は設定しか返さず、
  グループ一覧を返すイベントは無い。公開APIはKumaが応答を数分キャッシュすることがあり、古い一覧を
  読むと直前に足したモニターを外して保存してしまうため、`?_=<時刻>` を付けてキャッシュのキーを
  毎回変えている（Kuma側はクエリを見ない。Kumaを更新したら挙動を確かめ直す）
- **ページの設定は公開APIではなく管理者socketの `getStatusPage` から取る。** 公開APIが返す
  `config` には `domainNameList` が無く、それを渡して保存するとドメイン設定が消える
- **`login` の応答は、2要素認証が有効だと `{ tokenRequired: true }` で `ok` を持たない**
  （`server/server.js:377`）。`ok` だけを見ていると「拒否された」と誤って報告する
- **モニターは画面が送るのと同じ形で渡す。** サーバー側は受け取ったオブジェクトを RedBean の
  bean へ丸ごと import するだけで既定値を補完しない。`src/pages/EditMonitor.vue` の
  `monitorDefaults` を写した定数を `uptime-kuma-admin.ts` に持たせてあるので、Kumaを
  更新したときはそこを合わせ直す

`UPTIMEKUMA_USERNAME` / `UPTIMEKUMA_PASSWORD` が未設定なら登録機能は無効になり、監視タブの
「モニター追加」はKumaの `/add` を開くリンクへ戻る。設定を欠いたまま壊れないので、worktreeで
そのまま動かしてよい。

## AI利用枠のクレジット（サブスク外）

サブスクの制限枠とは別会計の「クレジット枠」は、**両方とも使用状況のレスポンスに同居している**。
別のエンドポイントを探さないこと（2026-08-30に実レスポンスで確認）。

- **Claude**（`GET /api/oauth/usage`）は同じ内容を `extra_usage` と `spend` の2箇所で返す。
  読むのは **`extra_usage`**（`is_enabled` / `monthly_limit` / `used_credits` / `utilization` /
  `currency` / `decimal_places`）。Claude Code 本体が読んでいるのがこちらで、金額は最小単位
  （USDならセント）。`spend` は同じ値を `amount_minor` + `exponent` で持つ古い形で、
  `src/lib/ai-usage/claude.ts` ではフォールバックとしてだけ残している。
  **リセット時刻はレスポンスに無い**ため、Claude Code と同じく翌月1日として扱う
- **ChatGPT**（`GET /backend-api/wham/usage`）は `credits`（`has_credits` / `unlimited` /
  `balance` / `approx_local_messages`）。**`balance` は数値ではなく文字列**で返る。
  購入した総量は返らないので**使用率（分母）を出せない**——バーではなく残高だけを出す。
  ワークスペースの上限（`spend_control.individual_limit`）は個人アカウントでは `null`

`/api/oauth/usage` の Claude `extra_usage` は前払い残高ではなく、月額上限と当月の使用額を返す。

**Claude.aiの画面に出る前払い残高・購入履歴は、サーバーから取得できない。** Claude Webの非公開API
（`GET https://claude.ai/api/organizations/{org}/prepaid/credits` など）は `sessionKey` cookieを要求するが、
その手前のCloudflareのボット判定で、cookieの有無・User-Agent・curl/Nodeの別によらず
**403（`cf-mitigated: challenge`）**が返る（#252でサブPCから確認）。sessionKeyを本番へ渡す経路を
作っても効果は無いので、再挑戦しないこと。#250で入れたsessionKey経路は#252で削除した。

代わりに `src/lib/ai-usage/claude-credit-ledger.ts` の**手入力の台帳**（`.data/claude-credit-ledger.json`）で出している。

- 購入（日付・金額）と「ある時点の残高（補正値）」を画面の「購入・残高を記録」から登録する
  （`POST/DELETE /api/ai-usage/claude-credits`。`/api/ai-usage` 配下はproxyの認証対象外なので、
  ルート側でセッションを確かめている）
- 推定残高 = 補正値 ＋ 補正日より後の購入 − 補正後の使用額。使用額は `extra_usage.used_credits` を
  取得のたびに観測し、**値が減ったら月のリセットとみなしてその値を足す**累計で持つ（暦の月で区切ると、
  提供元が月を切るタイムゾーンとずれて二重計上しうるため）。月末の最後の観測からリセットまでの分は
  取りこぼすので、ずれたら補正し直す運用
- 購入総額は購入日から1年以内（有効期限内）のものだけを合計する。期限切れで消えた残りの差し引きは再現しない
- 台帳の値は提供元の取得をキャッシュから返す回も毎回載せ直す（`applyClaudeCreditLedger`）。
  記録直後に画面へ出すため
- バーの青い区間（購入済み・未使用。#258）の幅は `getReservedPercent` が「推定残高 ÷ 月の上限」で出し、
  使用済みの右隣に描く。**残高が上限の残りを超える分は切る**（右端が上限の位置で止まる）。
  推定残高が無い・上限が無い・残高ゼロのときは出さない。ChatGPTは上限が無いので対象外

**画面確認は `/login` 配下の一時ルートから `parseClaudeUsageResponse` /
`parseChatGptUsageResponse` に実レスポンスを流し込むのが早い。** どちらの提供元も
リフレッシュトークンが要り、worktreeには `.env.local` が無いため実データを直接引けない。

## AI利用枠の「使い切り」（枠ごとの実績）

**過去の制限枠の実績を返すAPIはどちらの提供元にも無い。** 返るのは常に「いまの枠の使用率」だけなので、
`src/lib/ai-usage/history.ts` が取得のたびに枠ごとの値を `.data/ai-usage-windows.json` へ書き留め、
リセット時刻を過ぎた枠を確定値として扱っている（#244）。別のエンドポイントを探さないこと。

- **記録は「観測できた時点の値」でしかない。** 取得はリクエスト契機でしか走らず、サーバー側の定期実行は
  無い。枠の終了間際に観測が無い枠は実際より低い値で確定するため、`undersampled` を立てて画面では
  斜線で区別している。精度は観測の頻度に依存し、過去に遡って埋めることはできない
- **観測をつないでいるのは `POST /api/host-stats`。** ダッシュボードを誰も開いていない時間帯は
  ブラウザからのポーリングが止まるため、ホストのメトリクス受信を契機に `getAiUsageSnapshot()` も
  回している。**これにより提供元への問い合わせは常時5分間隔になる**（それまでは画面を開いている
  間だけ）。エージェントは1分ごとに届くが、キャッシュ（既定300秒）を挟むので実取得は5分に1回で、
  Anthropicが推奨する180秒以上の間隔は保たれる。**ホストのエージェントが止まると枠の記録も粗くなる**
- **リセット時刻の一致で枠を同定してはいけない。** ChatGPTは `reset_at` を返さないことがあり、
  その場合 `chatgpt.ts` が `Date.now() + reset_after_seconds` で組み立てるため、同じ枠でも取得の
  たびに数秒ずれる。同定は「リセット時刻が枠の半分より先へ進んだか」で行う
- **枠のキーは `windowSeconds` と `note` で組む。** Claudeの週間枠は全体・Opus・Sonnetの3本あり、
  `label` はどれも「週間」で同じなので、`label` でまとめると3本が1系列に潰れる
- **サンプルは1行ずつ足さず、枠ごとに最後の値だけを残す。** 使用率は枠の中で増える一方なので、
  確定値に要るのは最後の観測だけで、ログ形式にするとファイルだけが際限なく伸びる
- **取得中の要求は同じ取得へ相乗りさせている**（`usage-cache.ts` の `createSingleFlight`。AI・GitHub・
  1Passwordで共通。#274）。キャッシュが切れた瞬間に画面のポーリングと `POST /api/host-stats` が重なると、
  キャッシュの判定だけでは全員が提供元へ取りにいき、429になる。さらに、先に取った小さい使用額が
  後から `recordClaudeCreditUsage` へ積まれると「値が減った＝月のリセット」と誤認され、累計へ二重に
  足される。**キャッシュの判定から取得の開始までに `await` を挟まない**（挟むと相乗りをすり抜ける）
- **取得に失敗した提供元は記録しない**（`status !== "ok"`）。0%を実績として残すと、使わなかった枠として
  確定してしまう
- 画面は使用率で赤・橙へ色を変えない。ここは「払っている枠を使い切れたか」を見る場所で、
  たくさん使ったことは悪い状態ではないため、既存の `UsageBar` と同じ色使いにすると意味が逆に読める

## AI利用枠のプッシュ通知

利用枠が上限に近づくと、ヘッダー右上のメニュー内の「通知」行で登録した端末へWeb Pushで知らせる（#263・#268）。
条件は Claudeの5時間枠が90%以上・週間枠（Claudeの全体・Opus・Sonnet、ChatGPT）が95%以上・その枠が100%。
ChatGPTの5時間枠は対象外（Issueの指定）。

- **判定はサーバー側で、`getAiUsageSnapshot` が提供元から取れた回ごとに走る**（`src/lib/ai-usage/alerts.ts`）。
  `POST /api/host-stats` が取得を回しているため、画面を閉じていても5分おきに判定される。
  ホストのエージェントが止まると、画面を開くまで判定されない
- 同じ枠・同じ段階は1回だけ送り、`.data/ai-usage-alerts.json` に残す。枠の同定は history.ts と同じく
  「リセット時刻が枠の半分より先へ進んだか」で行う（ChatGPTのリセット時刻は取得のたびに数秒ずれる）。
  **登録した端末が無い間は記録もしない**（あとから登録した端末へ、いまの状態を送れるように）
- 購読は `.data/push-subscriptions.json`。プッシュサービスが404・410を返した購読は消す
- **`public/sw.js` は `src/proxy.ts` の matcher から外してある。** Service Workerのスクリプト取得が
  ログイン画面へリダイレクトされると、ブラウザは登録を失敗させる
- iPhone・iPadはホーム画面に追加したアプリからしか受け取れない（iOS 16.4以上）。Safariのタブでは
  「通知」行が「非対応」表示になる
- 鍵は `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY`（`npx web-push generate-vapid-keys`）。
  未設定ならメニューに「通知」行を出さず、判定もしない。**鍵を作り直すと登録済みの端末へは届かなくなる**ため、
  入れ替えたら各端末で「通知」行から登録し直す
- **メニューを閉じている間も `UsageNotifications` はマウントされたまま**（`HeaderMenu` はパネルを
  `hidden` で隠すだけ）。Service Workerの登録と、許可済み端末の購読の登録し直しはマウント時に走るため、
  開いたときだけ描画する形に変えると、メニューを開かない端末では通知の準備が走らなくなる
- worktreeで送信まで確かめるには、鍵を作ってコマンドに渡し、ログインした画面から登録する必要がある。
  GUIの無い環境では購読を作れないため、判定だけを `evaluateUsageAlerts` に作り物のスナップショットを流して確かめる

## 週間枠の「1日ごとの区切り」

週間枠のバーに立つ細い点線は、**その日の終わりまでの累計使用率**の位置にあり、線と線の間隔が
その日に使った量になる（#243）。提供元が返すのは現在の累計だけなので、日ごとの内訳は
`src/lib/ai-usage/day-marks.ts` が取得のたびに観測を `.data/ai-usage-days.json` へ残して導いている。

- **記録が進むのはダッシュボードを開いたときだけ。** 使用状況の取得はリクエスト契機でしか走らず、
  サーバー側の定期実行は無い（`github-repo-visibility.ts` と同じ性質の制約）
- **区切りの手前 6時間以内に観測が無い日は、線を出さない。** 前日の値をその日の終わりの値として
  置くと、間に使ったぶんが翌日の量として現れてしまうため。線が出なかった日は隣の日とまとまり、
  ホバーの内訳も「4〜5日目 +16%」のようにまとまって出る
- リセット時刻（`resetsAt`）が変わったら別の枠として記録を作り直すので、**リセット直後は線が無い**
- 画面確認は `/login` 配下の一時ルートを立て、`AI_USAGE_DAYS_PATH` に作業用のパスを与えて
  `attachDayMarks` を作り物の時刻で何度か呼ぶのが早い（`.data/` はworktreeと本番で別物のため、
  開発サーバーをそのまま動かしても線は出ない）

## GitHubの課金・使用量API

**Actions無料枠の「消費した分」を直接返すAPIは存在しない。** 旧 `GET /orgs/{org}/settings/billing/actions`
（`total_minutes_used` / `included_minutes` を返していた）と `.../shared-storage` は **HTTP 410 で廃止**され、
`GET /organizations/{org}/settings/billing/usage`（日次明細）と `.../usage/summary`（月次集計）へ統合された。
統合後のレスポンスには「無料枠を消費したか」を示す項目が無いため、ダッシュボードの無料枠ゲージは
**明細から導出した推定値**である。次の点に注意する。

- **無料枠を消費するのは非公開リポジトリの分だけ**だが、課金レポートは公開/非公開を返さない。
  リポジトリ一覧と突き合わせるしかないが、**「今」の公開状態で判定すると、月の途中で公開へ
  切り替えたリポジトリの非公開だった期間の分が丸ごと抜ける**（#151。実測で40%近くずれた）。
  `src/lib/github-repo-visibility.ts` が公開状態を `.data/` に記録し、使用日時点の状態で判定する。
  記録が始まる前の期間は `GH_USAGE_PRIVATE_UNTIL` で補う
- **記録に残るのは「切り替えた日」ではなく「切り替え後に初めてダッシュボードを開いた日」。**
  取得はリクエスト契機でしか走らず、サーバー側の定期実行は無い。開かない日が続くと、その期間は
  切り替え前の状態で判定される（非公開→公開なら多めに出る）。精度は開く頻度に依存する
- **月次集計 `usage/summary` を使う必要はない。** 同時刻に取れば分数も金額も日次明細の合計と一致する
  （実測で 41,048分・$246.72 が一致）。さらに `product` で絞らないとGHASのライセンス料まで
  混ざるうえ、明細とフィールド名（`quantity` と `grossQuantity`）も表記（`Minutes` と `minutes`）も違う
- `year` / `month` を付けずに叩くと、全リポジトリの合計が単一のリポジトリ名に束ねられて返る。
  リポジトリ別の内訳を出すときは必ず指定する
- 課金レポートのエンドポイントは **fine-grained PAT に非対応**。classic PAT（`repo` と `read:org`）を使う

## マルチエージェント運用（GitHub Actions 無人実行）

`@claude` コメントを起点に、計画提示〜実装〜develop向けPR作成までを GitHub Actions 上で無人実行する。
ワークフローの実体は `guchi-apps/issue-deck` にあり、このリポジトリの `.github/workflows/` には
`uses:` で参照する薄い caller だけを置いている。**callerを追加・更新する
ときは、`uses:` のタグと `prompts-ref` をリポジトリ内の全callerで同じ値に揃える。**

設計・運用の詳細は issue-deck 側を参照する。

- 進捗管理の設計: [progress-status-architecture.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/progress-status-architecture.md)
- 無人実行の挙動: [multi-agent/dispatch.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/dispatch.md)

### ブランチ

- 機能開発: `develop`
- 安定版 / 本番デプロイ: `main`（マージ時に GitHub Actions が VPS へデプロイ）

Issue専用ブランチは `develop` から作成し、ブランチ名は **`issue-<Issue番号>`** とする（例: `issue-64`）。
ワークフローはブランチ名から対象Issueを特定するため、**この命名規約に従わないブランチはすべて対象外**になる。

**以前使っていた `feature/<番号>-<説明>` では進捗が一切遷移しない。** 既存の `feature/` ブランチは
そのまま残してあるが、新しく作るブランチはすべて `issue-<番号>` にする。

デフォルトブランチは `develop` にしておく。`issues`・`issue_comment` イベントはデフォルトブランチの
ワークフローしか起動しないため、`main` にすると `@claude` コメントに反応しなくなる。

### Issueの進捗

**進捗は GitHub Projects の Status で管理する。進捗ラベルは存在しない**
（issue-deck#1010 / #991 Phase 5 で `01.wip`〜`09.main` を廃止した）。

1. `Ready` — 未着手
2. `Planning` — 計画検討中（`21.plan-required` 選択時のみ経由）
3. `Implementation` — 実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。この時点でissueをcloseする

**`gh issue edit` で進捗を進めることはできない。** Status を書けるのは issue-deck だけで、
ワークフローは進捗報告API（`POST /api/progress`）へ報告する。ブランチのpush・PR作成・PRマージを
トリガーに自動で遷移するため、エージェントが自分で進捗を動かす必要はない。

### リリース（develop→main）

**リリースは issue-deck の画面から起動する。** ヘッダーのロケットアイコン、またはブランチの流れ画面の
リリースボタンが `.github/workflows/release-develop-to-main.yml` を `workflow_dispatch` で起動し、
次の順に進む（issue-deck#1591）。

1. バージョンbump PR（`release/vX.Y.Z` → `develop`）が作られる。上げ幅は画面で指定するか、
   main と develop のコード差分から自動判定する。CI通過後に develop へ自動マージされる
2. バンプPRのマージで `package.json` が変わると同じワークフローが再度起動し、develop → main の
   リリースPRを作る
3. **リリースPRのマージは人が行う**（自動マージ不可カテゴリ）。マージすると `deploy.yml` が
   `v<version>` タグを作り、VPS へデプロイする

バンプ時には `npm version` の `version` フックから `scripts/version-changelog.mjs` が走り、
`src/data/changelog.ts` の先頭へ新バージョンのエントリを差し込む。文面は共有ワークフローが
差分から生成して `RELEASE_CHANGELOG` で渡してくるので、**バンプPRのレビュー時に内容を確認し、
必要なら直す**（利用者が読む文章のため）。

同じ経路で **`RELEASE_USAGE`（利用者向けの操作手順）** も渡ってくる（issue-deck#1729）。
`RELEASE_CHANGELOG` が「何が変わったか」、`RELEASE_USAGE` が「どう使うか」で、後者は
`ChangelogEntry.usage` として `changes` とは別に持たせ、更新履歴の画面でそのバージョンの
変更点の下に「使い方」として出す。**画面で使える変化が無いリリースでは空文字で渡るため、
そのときは `usage` の項目ごと出力しない**（空の見出しが残ると書き漏らしに見えるため）。
共有ワークフローの参照タグ（`@workflows/vN`）が上がるまでは実際には常に空文字が渡る。

**`preversion` にテストやlintを足さないこと。** 共有ワークフローはバージョンbumpのために
依存関係をインストールしない（`setup-node` も `npm ci` も無い）ため、`node_modules` を要する
スクリプトを lifecycle に置くとリリースが必ず失敗する。`version` フックから呼ぶスクリプトも
Node標準モジュールだけで書く。

エージェントはこのフローを自分で起動しない。バージョンを手で書き換える必要もない
（`package.json` の `version` はバンプPRだけが更新する）。

### 条件を表すラベル（進捗とは別軸）

Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担にしている。

| ラベル | 意味 |
|---|---|
| `00.check-user` | ユーザーの確認・指示が必要。どの段階でも併用する |
| `00.qa-answered` | 質問への回答のみ完了（`00.check-user` と常に併用） |
| `11.local` | ローカル（VSCode等）で対応中。付いている間は無人実行を起動しない |
| `21.plan-required` | 実装前に計画を提示し承認を得る |
| `22.merge-confirm-required` | 内容によらず、developへのマージ前に必ず `00.check-user` を付ける |
| `23.preview-required` | PR作成前に開発サーバーでの画面確認を必須にする |
| `24.screenshot-required` | PR作成前にスクリーンショット取得を必須にする |
| `71.manual-step` | エージェントが代行できないユーザー自身の手作業 |

### 自動マージ不可カテゴリ

以下に該当する変更は自動マージせず `00.check-user` を付与してユーザーの確認を待つ。

- 認証・認可（`src/proxy.ts`・認証まわりの `src/app/api/**`）
- 本番環境の設定（`deploy/**`）
- GitHub Actionsやデプロイ設定（`.github/workflows/**`）
- Secretsや環境変数（`.env*`・`scripts/sync-github-secrets.sh`）
- 外部サービスのトークンを扱う経路（AI利用枠・UptimeRobot・GitHub の各APIクライアント）
- 課金・決済
- 大規模な依存関係の更新
- `develop` → `main` のマージ

**develop向けPRのClaude Codeレビューは、このリポジトリでは毎回走る**（#233）。共有ワークフローの既定は
「リスクパスに該当」か「10ファイルまたは500行以上」のときだけ `claude-review` を実行し、それ以外を
skipする（guchi-apps/issue-deck#992。コスト削減のため）。既定のままだと、トークン処理を変えた#223を
含む小さなPRがすべてskipされていた。数行でも致命的になりうる変更はパスで列挙しきれないため、
`.github/workflows/claude-review-develop.yml` で `review-file-threshold: "1"` にしてある。

上のカテゴリのうちパス名から判別できないもの（認証・APIルート・トークンを扱うクライアント）は、
同じcallerの `risk-paths` に列挙してある。**判定の対象はパスだけなので、トークンやセッションを
扱うファイルを新しく足したら `risk-paths` にも足す**（足さなくてもレビューは走るが、`risk-check`
ジョブのサマリー「Claude Review 実行判定」に該当理由が出ない）。`merge-policy` は既定の `relaxed` のままで、該当してもdevelopへのマージは
止まらない（レビューが要修正と判定した場合だけ止まる）。

### 実装エージェントの禁止事項

- `main` / `develop` への直接コミット・push
- 他Issueのブランチの編集
- 担当Issue以外の実装（別件を新規Issueとして起票するのはよい）
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

### コミット・PR・コメントの書き方

- コミットメッセージ・PRタイトル・PR本文・issueコメントは**日本語**で書く
- コミットの author は `Claude Code <claude-code@example.com>` にする
- `develop` 宛のPR本文には、対応Issue・実装内容・テスト内容・確認方法・注意点を記載する。
  developマージ時点ではissueをcloseしない運用のため、`closes #番号` / `fixes #番号` は使わず
  `#番号` のみ記載する

### 依存関係の追加

新しい依存関係を追加する前には、必ずユーザーに確認を取る。無人実行では確認相手がいないため、
追加が必要だと判断した場合は追加せずに作業を止め、`00.check-user` を付与したうえで
なぜ必要かをIssueコメントで相談する。

### シークレットの扱い

APIキー・トークン・パスワード等の実シークレットをコミットしない。コミットしてよいのは値を空にした
サンプル（`.env.example`）と、1Passwordの `op://vault/item/field` 形式の参照だけを書いたテンプレートに
限る。実値は `.gitignore` 済みの `.env*` と1Password側、およびGitHubのsecret/variableにのみ置く。

**実行時の1Password呼び出しは行わない**（issue-deck#1307）。GitHub Actions は GitHubの
secret/variable から値を取得する。
