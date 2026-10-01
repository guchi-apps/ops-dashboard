/**
 * `ALLOWED_EMAILS`（カンマ区切り、複数可）。
 *
 * ログインの許可判定には使わない（#489。判定は共通アクセス設定のDB: src/lib/access/）。
 * アクセス設定DBを**初めて作るときだけ**、ここに載っているメールを管理者として取り込む
 * （移行用。取り込み後に変更しても反映されない）。
 */
export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
