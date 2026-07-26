/** ログインを許可するメールアドレス一覧（カンマ区切り、複数可）。 */
export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** 許可リスト未設定時は fail-closed（全拒否）。運用ダッシュボードのため厳格側に倒す。 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowedEmails = getAllowedEmails();
  if (allowedEmails.length === 0) return false;
  return !!email && allowedEmails.includes(email.toLowerCase());
}
