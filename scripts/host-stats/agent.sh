#!/usr/bin/env bash
#
# このホストのメトリクスを収集し、ops-dashboard の /api/host-stats へPOSTする。
#
# VPS・サブPCとも同じこのスクリプトを使う（push型に一本化）。サブPCは自宅LAN内（NAT配下）に
# いてダッシュボードからポーリングできないため、ホスト側から送る形にしている。
# VPS上ではダッシュボード自身が同じマシンで動いているため、送信先は localhost でよい。
#
# 設定は環境変数で渡す（systemd の EnvironmentFile を使う。README を参照）:
#   OPS_DASHBOARD_URL       必須。例: https://admin.gucchii.com（VPS上なら http://localhost:3110）
#   HOST_STATS_TOKEN        必須。ダッシュボード側の HOST_STATS_TOKEN と同じ値
#   HOST_STATS_ID           任意。保存先を分ける識別子。英小文字・数字・-・_（既定: ホスト名から生成）
#   HOST_STATS_LABEL        任意。画面の見出しに使う表示名（既定: ホスト名）
#   HOST_STATS_DISK_PATHS   任意。監視するマウントポイントをカンマ区切りで（既定: /）
#   HOST_STATS_SERVICES     任意。死活を見る systemd サービスをカンマ区切りで
#   HOST_STATS_TIMEOUT      任意。送信のタイムアウト秒（既定: 15）
#
# `--print` を付けて実行すると、送信せずに組み立てたJSONを表示する（設置時の確認用）。

set -euo pipefail

PAYLOAD_VERSION=1

# CPU・ネットワーク・ディスクI/Oは「1秒あけて2回読んだ差分」から求める。
# 前回値をファイルに残さずに済ませるため、この1秒を3種類で共有する。
SAMPLE_SECONDS=1

# 上位プロセスの対象にする最低の経過時間（秒）。これ未満の短命プロセスは %CPU が当てにならない
MIN_PROCESS_AGE_SECONDS=10

: "${OPS_DASHBOARD_URL:?OPS_DASHBOARD_URL が未設定です}"
: "${HOST_STATS_TOKEN:?HOST_STATS_TOKEN が未設定です}"
DISK_PATHS="${HOST_STATS_DISK_PATHS:-/}"
SERVICES="${HOST_STATS_SERVICES:-}"
TIMEOUT="${HOST_STATS_TIMEOUT:-15}"

HOSTNAME_VALUE="$(hostname)"
HOST_ID="${HOST_STATS_ID:-$(printf '%s' "$HOSTNAME_VALUE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/-*$//')}"
HOST_LABEL="${HOST_STATS_LABEL:-$HOSTNAME_VALUE}"

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

# 物理NICの受信・送信バイト数の累積。lo と仮想NIC（docker・veth・br など）は除く。
# 行頭が空白で始まりインタフェース名の直後がコロンのため、区切りを自前で分解する
read_network_sample() {
    awk '
        NR > 2 {
            line = $0
            sub(/^[ \t]+/, "", line)
            split(line, field, /[: \t]+/)
            if (field[1] ~ /^(lo|docker|veth|br-|virbr|tun|tap|wg)/) next
            rx += field[2]
            tx += field[10]
        }
        END { printf "%d %d", rx, tx }
    ' /proc/net/dev
}

# 物理ブロックデバイスの読み書きセクタ数の累積。パーティションやループバックは除く
read_diskio_sample() {
    awk '
        $3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|mmcblk[0-9]+|xvd[a-z]+)$/ {
            read_sectors += $6
            write_sectors += $10
        }
        END { printf "%d %d", read_sectors * 512, write_sectors * 512 }
    ' /proc/diskstats
}

# 1秒あけて2回読んだ差分から「%」と「バイト/秒」を求める
collect_samples() {
    local cpu_first net_first io_first cpu_second net_second io_second
    cpu_first="$(read_cpu_sample)"
    net_first="$(read_network_sample)"
    io_first="$(read_diskio_sample)"

    sleep "$SAMPLE_SECONDS"

    cpu_second="$(read_cpu_sample)"
    net_second="$(read_network_sample)"
    io_second="$(read_diskio_sample)"

    CPU_PERCENT="$(awk -v first="$cpu_first" -v second="$cpu_second" 'BEGIN {
        split(first, a, " "); split(second, b, " ")
        idle_delta = b[1] - a[1]
        total_delta = b[2] - a[2]
        if (total_delta <= 0) { print "0.0"; exit }
        printf "%.1f", (total_delta - idle_delta) / total_delta * 100
    }')"

    NETWORK_JSON="$(rate_json "$net_first" "$net_second")"
    DISK_IO_JSON="$(rate_json "$io_first" "$io_second")"
}

# 累積値の差分を秒あたりに直す。カウンタが巻き戻った（再起動等）ときは0にする
rate_json() {
    awk -v first="$1" -v second="$2" -v seconds="$SAMPLE_SECONDS" 'BEGIN {
        split(first, a, " "); split(second, b, " ")
        in_rate = (b[1] - a[1]) / seconds
        out_rate = (b[2] - a[2]) / seconds
        if (in_rate < 0) in_rate = 0
        if (out_rate < 0) out_rate = 0
        printf "{\"inBytesPerSecond\":%d,\"outBytesPerSecond\":%d}", in_rate, out_rate
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

# CPUを食っている上位3プロセス。カーネルスレッドは見ても仕方ないので除く。
# comm はスレッド名（MainThread など）になることがあるため、コマンドラインの実行ファイル名を使う。
#
# ps の %CPU は「起動してからの平均」であり、起動直後のプロセスほど高く出る。
# そのままだとエージェント自身が動かした ps が毎回1位に居座るため、
# 起動から MIN_PROCESS_AGE_SECONDS 経っていないプロセスは対象外にする。
collect_top_processes() {
    ps -eo etimes=,pcpu=,args= --sort=-pcpu 2>/dev/null |
        awk -v min_age="$MIN_PROCESS_AGE_SECONDS" 'NF >= 3 && $1 >= min_age && $2 > 0 {
            command = $3
            if (command ~ /^\[/) next
            sub(/.*\//, "", command)
            gsub(/[\\"]/, "", command)
            printf "%s{\"name\":\"%s\",\"cpuPercent\":%.1f}", (count++ ? "," : "["), command, $2
            if (count >= 3) exit
        }
        END { printf "%s", (count ? "]" : "[]") }'
}

# 再起動待ちと未適用の更新。いずれもファイルを見るだけで、apt を毎分叩いたりはしない
collect_maintenance() {
    local reboot="false" updates="" security=""

    [ -f /var/run/reboot-required ] && reboot="true"

    # update-notifier-common が定期的に書き出すファイルを読むだけにする。
    # apt-check を毎分呼ぶとCPUを1.5秒ほど使うが、この値は1日に数回しか変わらないため割に合わない。
    # ESM（有償のサポート延長）の行は、契約していなければ適用できない件数なので数えない
    if [ -r /var/lib/update-notifier/updates-available ]; then
        read -r updates security <<< "$(awk '
            /ESM/ { next }
            !updates && /^[0-9]+/ { updates = $1 }
            !security && /security|セキュリティ/ {
                match($0, /[0-9]+/)
                if (RSTART) security = substr($0, RSTART, RLENGTH)
            }
            END { printf "%d %d", updates, security }
        ' /var/lib/update-notifier/updates-available)"
    fi

    printf '{"rebootRequired":%s' "$reboot"
    [ -z "$updates" ] || printf ',"updatesAvailable":%d' "$updates"
    [ -z "$security" ] || printf ',"securityUpdatesAvailable":%d' "$security"
    printf '}'
}

collect_sessions() {
    local count users first=1 user
    count="$(who 2>/dev/null | wc -l)"
    users="$(who 2>/dev/null | awk '{ print $1 }' | sort -u)"

    printf '{"count":%d,"users":[' "$count"
    while IFS= read -r user; do
        [ -n "$user" ] || continue
        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '"%s"' "$(json_escape "$user")"
    done <<< "$users"
    printf ']}'
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
    collect_samples
    swap="$(collect_swap)"
    temperature="$(collect_temperature)"

    printf '{'
    printf '"version":%d,' "$PAYLOAD_VERSION"
    printf '"id":"%s",' "$(json_escape "$HOST_ID")"
    printf '"label":"%s",' "$(json_escape "$HOST_LABEL")"
    printf '"hostname":"%s",' "$(json_escape "$HOSTNAME_VALUE")"
    printf '"os":"%s",' "$(json_escape "$(os_name)")"
    printf '"kernel":"%s",' "$(json_escape "$(uname -r)")"
    printf '"collectedAt":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '"cpuPercent":%s,' "$CPU_PERCENT"
    printf '"memory":%s,' "$(collect_memory)"
    [ -z "$swap" ] || printf '"swap":%s,' "$swap"
    printf '"disks":%s,' "$(collect_disks)"
    printf '"loadAverage":[%s],' "$(awk '{ printf "%s,%s,%s", $1, $2, $3 }' /proc/loadavg)"
    printf '"uptimeSeconds":%d,' "$(awk '{ printf "%d", $1 }' /proc/uptime)"
    [ -z "$temperature" ] || printf '"temperatureCelsius":%s,' "$temperature"
    printf '"network":%s,' "$NETWORK_JSON"
    printf '"diskIo":%s,' "$DISK_IO_JSON"
    printf '"topProcesses":%s,' "$(collect_top_processes)"
    printf '"maintenance":%s,' "$(collect_maintenance)"
    printf '"sessions":%s,' "$(collect_sessions)"
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
