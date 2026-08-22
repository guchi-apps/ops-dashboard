const APP_NAME = "ops-dashboard"; // 通知タイトルに使うアプリ名。他アプリへ流用する場合はここだけ変更する

/** Discord の embed で使う色。異常は赤、復旧は緑、ログインは既存の青のまま */
const COLOR_ALERT = 15548997;
const COLOR_RECOVERY = 5763719;
const COLOR_LOGIN = 5763719;

interface SignalyField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Webhookへ1件投げる。URL未設定・送信失敗のどちらでも呼び出し元は止めない */
async function postToSignaly(
  webhookUrl: string | undefined,
  embed: { title: string; description?: string; color: number; fields: SignalyField[] },
): Promise<void> {
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            ...embed,
            fields: embed.fields.map((field) => ({ inline: false, ...field })),
          },
        ],
      }),
    });
  } catch (error) {
    console.error("Signaly notification failed:", error);
  }
}

/** Googleログイン成功時にSignalyへ通知する。Webhook URL未設定時は何もしない。 */
export async function notifySignalyLogin(ip: string | null): Promise<void> {
  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const fields: SignalyField[] = [{ name: "時刻", value: timestamp }];
  if (ip) {
    fields.push({ name: "IP", value: ip });
  }

  await postToSignaly(process.env.SIGNALY_LOGIN_WEBHOOK_URL, {
    title: `🔐 ${APP_NAME} にログイン`,
    color: COLOR_LOGIN,
    fields,
  });
}

/**
 * 異常・復旧をSignalyへ通知する（#75）。
 *
 * ログイン通知とはチャンネルを分ける（`SIGNALY_ALERT_WEBHOOK_URL`）。ログインは日常的に流れる
 * 記録で、こちらは「気づかないと壊れたままになるもの」だけを流す場所にしたいため。
 * 未設定なら何もしない（通知だけが無効になり、画面表示はそのまま動く）。
 */
export async function notifySignalyAlert(input: {
  /** 「Zaim同期が失敗」のような、通知一覧で読める見出し */
  title: string;
  /** 見出しだけでは足りない補足。何が起きているかを1〜2行で */
  description?: string;
  fields?: SignalyField[];
  /** 異常の発生か、復旧か */
  kind: "alert" | "recovery";
}): Promise<void> {
  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  await postToSignaly(process.env.SIGNALY_ALERT_WEBHOOK_URL, {
    title: `${input.kind === "alert" ? "🚨" : "✅"} ${input.title}`,
    description: input.description,
    color: input.kind === "alert" ? COLOR_ALERT : COLOR_RECOVERY,
    fields: [...(input.fields ?? []), { name: "時刻", value: timestamp }],
  });
}
