/** returnTo パラメータのオープンリダイレクト対策。自サイト内の相対パスのみ許可する。 */
export function sanitizeReturnTo(returnTo: string | undefined | null): string {
  if (!returnTo) return "/";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  return returnTo;
}
