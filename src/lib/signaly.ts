import { headers } from "next/headers";
import { clientIpFromForwardedFor } from "@/lib/client-ip";
import { describeError, fetchWithTimeout, readErrorBody } from "@/lib/upstream";

// 通知タイトルに使うアプリ名。ログイン通知の `source`（送信元）にも使うため、値はリポジトリ名に
// 揃える（CI・デプロイ通知はembedの `Repository` フィールドの末尾から送信元を作るため）。
// 他アプリへ流用する場合はここだけ変更する
const APP_NAME = "ops-dashboard";

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

// ログイン通知の色。他アプリと1本のチャンネルを共有するため、Discord の10進数ではなく
// 共通フォーマットが定める CSS hex で送る。
const LOGIN_COLOR = "#57f287";
const MAX_VALUE_LEN = 500;

// sv-SE ロケールは `2026-08-25 14:03:22` を返す。ja-JP だと `2026/8/25 14:03:22` になり、
// 月日がゼロ埋めされず桁が揃わないため使わない。
function jstTimestamp(): string {
  const text = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  return `${text} JST`;
}

/**
 * Googleログイン成功時にSignalyへ通知する。Webhook URL未設定時は何もしない。
 *
 * **フォーマットの正は signaly の `docs/webhook.md`「ログイン通知の共通フォーマット」。**
 * ログイン通知は全アプリで1本のチャンネルへ集約しているため、ここだけ独自の形にすると、
 * 並べたときに同じ種類の通知に見えない（guchi-apps/signaly#204）。アラート通知
 * （`notifySignalyAlert`）は別チャンネルなので、従来どおり Discord 形式のまま。
 *
 * **フィールド名 `接続元IP` を変えないこと。** Signaly はこの名前を手がかりに
 * 「見覚えのない接続元からのログインか」を判定し、初めての接続元なら通知を黄色にする。
 */
export async function notifySignalyLogin(
  options: {
    email?: string | null;
    name?: string | null;
    provider?: string | null;
  } = {},
): Promise<void> {
  const webhookUrl = process.env.SIGNALY_LOGIN_WEBHOOK_URL;
  if (!webhookUrl) return;

  const headersList = await headers();
  // `X-Real-IP` は読まない。Apacheはこのヘッダーを付けないため、クライアントが送った値がそのまま
  // 届くだけで、「見覚えのある接続元」を名乗る手段になる
  const ip = clientIpFromForwardedFor(headersList.get("x-forwarded-for"));
  const userAgent = headersList.get("user-agent");

  // 値が取れない項目は「不明」と書かず、フィールドごと落とす。「不明」を並べると
  // どのアプリでも行数は揃うが、実際に取れている情報が読み取れなくなる。
  const fields: SignalyField[] = [];
  const push = (name: string, value: string | null | undefined, inline: boolean) => {
    if (value) fields.push({ name, value: value.slice(0, MAX_VALUE_LEN), inline });
  };

  push("ユーザー", options.name, true);
  push("メール", options.email, true);
  push("プロバイダ", options.provider, true);
  push("接続元IP", ip, true);
  fields.push({ name: "日時", value: jstTimestamp(), inline: false });
  push("User-Agent", userAgent, false);

  await postWebhook(
    webhookUrl,
    {
      // 集約先のチャンネルではチャンネルで送信元を見分けられないため、必ず載せる
      source: APP_NAME,
      title: `🔐 ${APP_NAME} ログイン`,
      level: "info",
      color: LOGIN_COLOR,
      fields,
    },
    "ログイン通知",
  );
}

/**
 * 異常・復旧をSignalyへ通知する（#75）。
 *
 * ログイン通知とはチャンネルを分ける（`SIGNALY_ALERT_WEBHOOK_URL`）。ログインは日常的に流れる
 * 記録で、こちらは「気づかないと壊れたままになるもの」だけを流す場所にしたいため。
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
