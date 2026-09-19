/**
 * `npm test` 用: テストの実行前に `@/` エイリアスの解決フックを登録する。
 *
 * Node標準のテストランナーは tsconfig の `paths` を読まないため、`@/lib/...` のような
 * 参照はそのままでは解決できない。フックの実体は test-alias-loader.mjs。
 * 依存パッケージは使わず、Node標準の機能だけで済ませている。
 */
import { register } from "node:module";

register("./test-alias-loader.mjs", import.meta.url);
