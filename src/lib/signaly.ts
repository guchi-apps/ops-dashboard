import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream";

/** Discord の embed で使う色。異常は赤、復旧は緑（アラート通知のみ） */
const COLOR_ALERT = 15548997;
const COLOR_RECOVERY = 5763719;

interface SignalyField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * WebhookへJSONを1件投げ、届いたかどうかを返す。例外は投げない（呼び出し元は止めない）。
 *
 * **`fetch` は5xxでも例外を投げない**ため、`res.ok` を見ないと「Signaly側が受け取れなかった」
 * ことが分からず、失敗がログにも残らない。応答しない相手にも待たされないよう、タイムアウトを付ける
 * （エージェントの `POST /api/host-stats` やログインの完了が、この送信の完了を待っているため）。
 */
async function postWebhook(webhookUrl: string, body: unknown, label: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return true;

    // URLがWebhookの認証を兼ねるため、ログにはURLを出さずステータスと本文だけを残す
    console.error(`[signaly] ${label}の送信が拒否されました: ${res.status} ${await readErrorBody(res)}`);
  } catch (error) {
    console.error(`[signaly] ${label}の送信に失敗しました:`, describeError(error));
  }
  return false;
}

/**
 * アラート用のWebhookへ1件投げる。届いたら `true`。
 *
 * URL未設定は通知が無効なだけなので `true`（送るものが無い）を返す。`false` にすると、呼び出し元が
 * 「送れていないから再送する」と毎回やり直し続けてしまう。
 */
async function postToSignaly(
  webhookUrl: string | undefined,
  embed: { title: string; description?: string; color: number; fields: SignalyField[] },
  /**
   * 送信元の識別子（リポジトリ名）。複数アプリで1つのチャンネルを共有する通知では、
   * Signalyがこの値で送信元を見分ける（guchi-apps/signaly#192）。省略時は付けない。
   */
  source?: string,
): Promise<boolean> {
  if (!webhookUrl) return true;

  return postWebhook(
    webhookUrl,
    {
      ...(source ? { source } : {}),
      embeds: [
        {
          ...embed,
          fields: embed.fields.map((field) => ({ inline: false, ...field })),
        },
      ],
    },
    "アラート通知",
  );
}

/**
 * 異常・復旧をSignalyへ通知する（#75）。
 *
 * 異常通知用のWebhook（`SIGNALY_ALERT_WEBHOOK_URL`）へ送る。
 * 未設定なら何もしない（通知だけが無効になり、画面表示はそのまま動く）。
 *
 * **届いたかどうかを返す**。呼び出し元が「通知済み」を記録するのは、`true` のときだけにすること。
 * 送れなかったのに記録すると、その通知は二度と再送されない。
 */
export async function notifySignalyAlert(input: {
  /** 「Zaim同期が失敗」のような、通知一覧で読める見出し */
  title: string;
  /** 見出しだけでは足りない補足。何が起きているかを1〜2行で */
  description?: string;
  fields?: SignalyField[];
  /** 異常の発生か、復旧か */
  kind: "alert" | "recovery";
}): Promise<boolean> {
  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  return postToSignaly(process.env.SIGNALY_ALERT_WEBHOOK_URL, {
    title: `${input.kind === "alert" ? "🚨" : "✅"} ${input.title}`,
    description: input.description,
    color: input.kind === "alert" ? COLOR_ALERT : COLOR_RECOVERY,
    fields: [...(input.fields ?? []), { name: "時刻", value: timestamp }],
  });
}
