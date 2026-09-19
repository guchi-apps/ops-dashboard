/**
 * `X-Forwarded-For` から、リバースプロキシ（Apache）が付けた接続元IPを取り出す。
 *
 * **先頭ではなく末尾を読む。** mod_proxy はクライアントが送った `X-Forwarded-For` を消さず、
 * その末尾へ自分が見た接続元IPを足す。先頭の要素はクライアントが自由に決められるため、
 * 先頭を読むと「見覚えのある接続元」を名乗れてしまう（#281）。末尾はプロキシだけが書ける。
 * Apache側で `RequestHeader unset X-Forwarded-For` を入れていれば要素は1つだけになり、
 * どちらの構成でも同じ値になる。
 *
 * プロキシが1段（Apache のみ）の前提。CDNなどを手前に足した場合は、末尾がそのCDNのIPになる。
 */
export function clientIpFromForwardedFor(value: string | null | undefined): string | null {
  if (!value) return null;

  const last = value.split(",").at(-1)?.trim();
  return last ? last : null;
}
