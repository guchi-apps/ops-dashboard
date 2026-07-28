const APP_NAME = "ops-dashboard"; // 通知タイトルに使うアプリ名。他アプリへ流用する場合はここだけ変更する

/** Googleログイン成功時にSignalyへ通知する。Webhook URL未設定時は何もしない。 */
export async function notifySignalyLogin(ip: string | null): Promise<void> {
  const webhookUrl = process.env.SIGNALY_LOGIN_WEBHOOK_URL;
  if (!webhookUrl) return;

  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "時刻", value: timestamp, inline: false },
  ];
  if (ip) {
    fields.push({ name: "IP", value: ip, inline: false });
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{ title: `🔐 ${APP_NAME} にログイン`, color: 5763719, fields }],
      }),
    });
  } catch (error) {
    console.error("Signaly notification failed:", error);
  }
}
