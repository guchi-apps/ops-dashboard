/**
 * テスト用のモジュール解決フック。tsconfig の `paths`（`@/*` → `src/*`）と同じ対応を再現する。
 *
 * ソース側は拡張子なしで `@/lib/ai-usage/common` のように書いている（tsc の bundler 解決）が、
 * Node のESM解決は拡張子を補わないため、`.ts` と `<dir>/index.ts` を順に探す。
 */
import { existsSync } from "node:fs";

const SRC_ROOT = new URL("../src/", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = specifier.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const url = new URL(candidate, SRC_ROOT);
    if (existsSync(url)) return nextResolve(url.href, context);
  }

  return nextResolve(specifier, context);
}
