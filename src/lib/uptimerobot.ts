import { monitorFeedError, monitorFeedOk, type MonitorFeed } from "@/lib/monitor-feed";

export interface UptimeRobotMonitor {
    id: number;
    friendly_name: string;
    url: string;
    type: number;
    sub_type?: string;
    keyword_type?: number;
    keyword_value?: string;
    http_username?: string;
    http_password?: string;
    port?: string;
    interval: number;
    status: number; // 0: paused, 1: not checked yet, 2: up, 8: seems down, 9: down
    create_datetime: number;
    uptime_ratio: string; // "99.98" etc. (hyphen separated if multiple ranges)
    all_time_uptime_ratio?: string;
    custom_uptime_ratio?: string;
}

/** APIキーが無ければ失敗ではなく「監視が無い」として `error: null` で返す。 */
async function fetchUptimeRobotMonitors(
    apiKey: string | undefined
): Promise<MonitorFeed<UptimeRobotMonitor>> {
    if (!apiKey) {
        return monitorFeedOk([]);
    }

    try {
        const res = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `api_key=${apiKey}&format=json&logs=0&custom_uptime_ratios=30`,
            cache: 'no-store'
        });

        // 失敗時もJSONで理由が返るため、読めなかったときだけ null にして HTTP ステータスへ回す
        const data = await res.json().catch(() => null);

        if (data?.stat === 'ok' && Array.isArray(data.monitors)) {
            return monitorFeedOk(data.monitors);
        }

        console.error('UptimeRobot API Error:', res.status, data?.error);

        if (typeof data?.error?.type === 'string') {
            return monitorFeedError(`APIエラー: ${data.error.type}`);
        }
        return monitorFeedError(res.ok ? '応答の形式が想定と異なります' : `HTTP ${res.status}`);
    } catch (err) {
        console.error('Failed to fetch UptimeRobot data:', err);
        return monitorFeedError('接続できません');
    }
}

export async function fetchUptimeRobotMonitorsServer(): Promise<MonitorFeed<UptimeRobotMonitor>> {
    return fetchUptimeRobotMonitors(process.env.UPTIMEROBOT_READ_ONLY_KEY);
}

export function getUptimeRobotStatusInfo(status: number): { text: string; color: string } {
    switch (status) {
        case 2:
            return { text: "Running", color: "text-status-ok" }
        case 8:
        case 9:
            return { text: "Down", color: "text-red-500 dark:text-red-400" }
        case 0:
            return { text: "Paused", color: "text-yellow-500 dark:text-yellow-400" }
        case 1:
            return { text: "Checking...", color: "text-primary" }
        default:
            return { text: "Unknown", color: "text-slate-400" }
    }
}
