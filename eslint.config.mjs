import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // サーバーデプロイ用の設定ファイル（PM2 ecosystem config等）。CJS前提でNode.jsが
    // 直接読み込むため、アプリ本体のTypeScript向けlintルールの対象外とする。
    "deploy/**",
  ]),
]);

export default eslintConfig;
