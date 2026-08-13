#!/usr/bin/env bash
#
# サブPCのメトリクスを収集し、ops-dashboard の /api/host-stats へPOSTする。
#
# ダッシュボードはVPS上で動いており、自宅LAN内のサブPCへポーリングできないため、
# サブPC側から定期的に送る（push型）。systemd timer から1分間隔で起動する想定。
#
# 設定は環境変数で渡す（systemd の EnvironmentFile を使う。README を参照）:
#   OPS_DASHBOARD_URL       必須。例: https://admin.gucchii.com
#   HOST_STATS_TOKEN        必須。ダッシュボード側の HOST_STATS_TOKEN と同じ値
#   HOST_STATS_DISK_PATHS   任意。監視するマウントポイントをカンマ区切りで（既定: /）
#   HOST_STATS_SERVICES     任意。死活を見る systemd サービスをカンマ区切りで
#   HOST_STATS_TIMEOUT      任意。送信のタイムアウト秒（既定: 15）
#
# `--print` を付けて実行すると、送信せずに組み立てたJSONを表示する（設置時の確認用）。

set -euo pipefail

PAYLOAD_VERSION=1

: "${OPS_DASHBOARD_URL:?OPS_DASHBOARD_URL が未設定です}"
: "${HOST_STATS_TOKEN:?HOST_STATS_TOKEN が未設定です}"
DISK_PATHS="${HOST_STATS_DISK_PATHS:-/}"
SERVICES="${HOST_STATS_SERVICES:-}"
TIMEOUT="${HOST_STATS_TIMEOUT:-15}"

# JSONの文字列に埋め込めない文字を潰す（ホスト名・ディストリ名程度なのでこれで足りる）
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g'
}

# 「使用量・全体量・使用率(%)」のオブジェクトを組み立てる
usage_json() {
    local used="$1" total="$2"
    awk -v used="$used" -v total="$total" 'BEGIN {
        percent = (total > 0) ? used / total * 100 : 0
        printf "{\"usedBytes\":%d,\"totalBytes\":%d,\"usedPercent\":%.1f}", used, total, percent
    }'
}

# /proc/stat の1行目から「アイドル時間の累積」と「全体の累積」を取り出す
read_cpu_sample() {
    awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat
}

collect_cpu_percent() {
    local first second
    first="$(read_cpu_sample)"
    sleep 1
    second="$(read_cpu_sample)"

    awk -v first="$first" -v second="$second" 'BEGIN {
        split(first, a, " ")
        split(second, b, " ")
        idle_delta = b[1] - a[1]
        total_delta = b[2] - a[2]
        if (total_delta <= 0) { print "0.0"; exit }
        printf "%.1f", (total_delta - idle_delta) / total_delta * 100
    }'
}

collect_memory() {
    local total available
    total=$(awk '/^MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo)
    available=$(awk '/^MemAvailable:/ { print $2 * 1024; exit }' /proc/meminfo)
    usage_json "$((total - available))" "$total"
}

# Swapを積んでいないマシンでは何も出力しない（ダッシュボード側でカードごと省かれる）
collect_swap() {
    local total free
    total=$(awk '/^SwapTotal:/ { print $2 * 1024; exit }' /proc/meminfo)
    free=$(awk '/^SwapFree:/ { print $2 * 1024; exit }' /proc/meminfo)
    [ "$total" -gt 0 ] || return 0
    usage_json "$((total - free))" "$total"
}

collect_disks() {
    local first=1 path fields size used
    printf '['
    while IFS= read -r path; do
        [ -n "$path" ] || continue

        # df -P はロケールに依らない1行1レコードの形式。size/used はバイト単位で取る
        fields="$(df -B1 -P "$path" 2>/dev/null | awk 'NR == 2 { print $2, $3 }')" || fields=""
        [ -n "$fields" ] || continue
        size="${fields%% *}"
        used="${fields##* }"

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"path":"%s",' "$(json_escape "$path")"
        usage_json "$used" "$size" | sed 's/^{//'
    done < <(printf '%s\n' "$DISK_PATHS" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

collect_services() {
    local first=1 name state
    printf '['
    while IFS= read -r name; do
        [ -n "$name" ] || continue

        # inactive・failed のときは終了ステータスが非0になるため、出力だけ拾う
        state="$(systemctl is-active "$name" 2>/dev/null || true)"
        [ -n "$state" ] || state="unknown"

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"name":"%s","state":"%s"}' "$(json_escape "$name")" "$(json_escape "$state")"
    done < <(printf '%s\n' "$SERVICES" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

# CPU温度。センサーの構成はマシンによって違うため、パッケージ温度らしいゾーンを優先して1つだけ拾う
collect_temperature() {
    local zone type milli preferred=""
    for zone in /sys/class/thermal/thermal_zone*; do
        [ -r "$zone/temp" ] || continue
        type="$(cat "$zone/type" 2>/dev/null || true)"
        case "$type" in
            x86_pkg_temp | coretemp | k10temp | cpu-thermal | acpitz)
                preferred="$zone"
                break
                ;;
        esac
        [ -n "$preferred" ] || preferred="$zone"
    done

    [ -n "$preferred" ] || return 0
    milli="$(cat "$preferred/temp" 2>/dev/null || true)"
    [ -n "$milli" ] || return 0
    awk -v milli="$milli" 'BEGIN { printf "%.1f", milli / 1000 }'
}

os_name() {
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}"
    else
        printf 'Linux'
    fi
}

build_payload() {
    local swap temperature
    swap="$(collect_swap)"
    temperature="$(collect_temperature)"

    printf '{'
    printf '"version":%d,' "$PAYLOAD_VERSION"
    printf '"hostname":"%s",' "$(json_escape "$(hostname)")"
    printf '"os":"%s",' "$(json_escape "$(os_name)")"
    printf '"kernel":"%s",' "$(json_escape "$(uname -r)")"
    printf '"collectedAt":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '"cpuPercent":%s,' "$(collect_cpu_percent)"
    printf '"memory":%s,' "$(collect_memory)"
    [ -z "$swap" ] || printf '"swap":%s,' "$swap"
    printf '"disks":%s,' "$(collect_disks)"
    printf '"loadAverage":[%s],' "$(awk '{ printf "%s,%s,%s", $1, $2, $3 }' /proc/loadavg)"
    printf '"uptimeSeconds":%d,' "$(awk '{ printf "%d", $1 }' /proc/uptime)"
    [ -z "$temperature" ] || printf '"temperatureCelsius":%s,' "$temperature"
    printf '"services":%s' "$(collect_services)"
    printf '}'
}

main() {
    local payload response status body
    payload="$(build_payload)"

    # 設置時の確認用。送信はせずJSONだけ出す
    if [ "${1:-}" = "--print" ]; then
        printf '%s\n' "$payload"
        return 0
    fi

    response="$(
        printf '%s' "$payload" | curl -sS \
            --max-time "$TIMEOUT" \
            -X POST \
            -H "Authorization: Bearer ${HOST_STATS_TOKEN}" \
            -H "Content-Type: application/json" \
            --data-binary @- \
            -w '\n%{http_code}' \
            "${OPS_DASHBOARD_URL%/}/api/host-stats"
    )"

    status="${response##*$'\n'}"
    body="${response%$'\n'*}"

    if [ "$status" != "200" ]; then
        echo "host-stats の送信に失敗しました (HTTP ${status}): ${body}" >&2
        exit 1
    fi
}

main "$@"
