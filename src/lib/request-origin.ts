import { headers } from "next/headers";

/**
 * 現在のリクエストのoriginを取得する。
 * Origin ヘッダーはリバースプロキシ経由だと送られてこないことがあるため、
 * Apache側で必ず付与している Host（ProxyPreserveHost On で保持）と
 * X-Forwarded-Proto から組み立てる。
 */
export async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}
