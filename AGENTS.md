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

ダッシュボード本体（`DashboardShell`）は確認用ルートからでもそのまま描画できる。`DashboardDataProvider`
に `initial={{ uptimeKuma: [], uptimeRobot: [] }}` を渡せば、実データが無くてもタブの構造まで
HTMLに出るため、レイアウトやクラスの確認はこれで足りる（#136）。

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
- **日次明細は月初まで遡れないことがある**（組織が新しい課金基盤へ移行した日以降しか返らない）。
  月全体の合計と課金額は `usage/summary` から取る
- `year` / `month` を付けずに叩くと、全リポジトリの合計が単一のリポジトリ名に束ねられて返る。
  リポジトリ別の内訳を出すときは必ず指定する
- 課金レポートのエンドポイントは **fine-grained PAT に非対応**。classic PAT（`repo` と `read:org`）を使う

## マルチエージェント運用（GitHub Actions 無人実行）

`@claude` コメントを起点に、計画提示〜実装〜develop向けPR作成までを GitHub Actions 上で無人実行する。
ワークフローの実体は `guchi-apps/issue-deck` にあり、このリポジトリの `.github/workflows/` には
`uses:` で参照する薄い caller だけを置いている（現在は `@workflows/v23`）。**callerを追加・更新する
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
