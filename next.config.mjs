// @ts-check
// 設定ファイルは**TypeScriptにしない**（#291。issue-deck#3017・#3027の横展開）。`next.config.ts`だと、
// 本番の`next start`が起動時にこれをトランスパイルするためだけにSWCのネイティブバイナリを読み込み、
// そのまま常駐する（issue-deckの実測でRSS約43MB・スレッド12本ぶん）。型はJSDocで付ける。

/** @type {import("next").NextConfig} */
const nextConfig = {
  /* config options here */
};

export default nextConfig;
