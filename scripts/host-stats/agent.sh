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
#   HOST_STATS_TMUX_SOCKET_ROOT
#                           任意。tmuxのソケットを探すディレクトリ（既定: /tmp）
#   HOST_STATS_SESSION_STATE_SUBDIR
#                           任意。issue-deckがセッションの状態を置く、ホームからの相対パス
#                           （既定: .local/state/issue-deck/sessions）
#
# `--print` を付けて実行すると、送信せずに組み立てたJSONを表示する（設置時の確認用）。

set -euo pipefail

PAYLOAD_VERSION=1

# CPU・ネットワーク・ディスクI/Oは「1秒あけて2回読んだ差分」から求める。
# 前回値をファイルに残さずに済ませるため、この1秒を3種類で共有する。
SAMPLE_SECONDS=1

# 上位プロセスの対象にする最低の経過時間（秒）。これ未満の短命プロセスは %CPU が当てにならない
MIN_PROCESS_AGE_SECONDS=10

# CPU順・メモリ順それぞれで送る上位プロセスの件数。ダッシュボード側の上限と合わせる
MAX_TOP_PROCESSES=5

# 送るtmuxセッションの上限。ダッシュボード側も同数で切るため、超えた分は表示されない。
# 切り捨てたことに気づけるよう、実際の総数は tmuxSessionTotal で別に送る
MAX_TMUX_SESSIONS=20

# 1セッションあたりに送る「実行中コマンド」の数の上限
MAX_TMUX_COMMANDS=3

# 稼働中とみなさないコマンド。プロンプトで止まっているだけのシェルはここに挙げる
TMUX_SHELL_COMMANDS="bash zsh sh fish dash ksh csh tcsh"

: "${OPS_DASHBOARD_URL:?OPS_DASHBOARD_URL が未設定です}"
: "${HOST_STATS_TOKEN:?HOST_STATS_TOKEN が未設定です}"
DISK_PATHS="${HOST_STATS_DISK_PATHS:-/}"
SERVICES="${HOST_STATS_SERVICES:-}"
TIMEOUT="${HOST_STATS_TIMEOUT:-15}"
TMUX_SOCKET_ROOT="${HOST_STATS_TMUX_SOCKET_ROOT:-/tmp}"
SESSION_STATE_SUBDIR="${HOST_STATS_SESSION_STATE_SUBDIR:-.local/state/issue-deck/sessions}"

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

# 資源を食っている上位プロセス。カーネルスレッドは見ても仕方ないので除く。
# comm はスレッド名（MainThread など）になることがあるため、コマンドラインの実行ファイル名を使う。
#
# ps の %CPU は「起動してからの平均」であり、起動直後のプロセスほど高く出る。
# そのままだとエージェント自身が動かした ps が毎回1位に居座るため、
# 起動から MIN_PROCESS_AGE_SECONDS 経っていないプロセスは対象外にする。
#
# 呼び出し側はCPU順とメモリ順の2本を送る。メモリ枯渇でホストが止まる事故では、犯人が
# CPU順の一覧に出てこない。1本あたりのCPUは軽くても本数でメモリを食い潰すためで、
# CPU順だけを見ていると停止の直前まで異常に見えない（#54）。
#
# $1: ps の --sort に渡す並び順  $2: 0より大きいことを求める列（2=%CPU・3=RSS）
top_processes_json() {
    ps -eo etimes=,pcpu=,rss=,args= --sort="$1" 2>/dev/null |
        awk -v min_age="$MIN_PROCESS_AGE_SECONDS" -v max="$MAX_TOP_PROCESSES" -v key="$2" 'NF >= 4 && $1 >= min_age && $key > 0 {
            command = $4
            if (command ~ /^\[/) next
            sub(/.*\//, "", command)
            gsub(/[\\"]/, "", command)
            # RSS は KiB で返るためバイトに直す
            printf "%s{\"name\":\"%s\",\"cpuPercent\":%.1f,\"memoryBytes\":%d}", (count++ ? "," : "["), command, $2, $3 * 1024
            if (count >= max) exit
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

# tmuxのセッション一覧。
#
# サブPCはClaude Codeの作業セッションを常駐させるホストで、リポジトリをまたいだセッションが
# 同じ tmux ls に並ぶ。いま何が動いているかが見えないと、二重起動や放置セッションに気づけない。
#
# 動いているかどうかはアタッチの有無では判断できない。デタッチしたまま裏でclaudeが走っているのが
# 普通の使い方で、それを「待機中」と読んでしまうと一覧の意味がなくなる。
# そのため各ペインの実行コマンドを見て、シェル以外が動いていれば稼働中として送る。
#
# ソケットはユーザーごとに <ソケット置き場>/tmux-<UID>/ にあり、rootで `tmux ls` を叩いても
# root自身のサーバーしか見えない。そのためソケットを列挙して -S で個別に問い合わせる。
# ソケットのディレクトリは 0700 でユーザー所有だが、rootはDACを迂回できるため読める。
# （systemdユニットで PrivateTmp=no にしているのは、ここで実ホストの /tmp を見るため）

# 1ソケット分のセッションを「1行1セッション」のTSVにまとめる。
#
# ペイン側の情報（実行コマンド・作業ディレクトリ）はセッション単位に畳んでから返す。
# 一覧と畳み込みを2回の tmux 呼び出しで済ませるため、両方の出力を1つのawkに流し込み、
# 行頭の P / S で区別している。
#
# **最終活動には `#{window_activity}` を使う。`#{session_activity}` ではない**（#72）。
# `session_activity` が動くのはクライアントの操作（アタッチ・キー入力）で、ペインの出力では
# 更新されない。デタッチしたまま裏でclaudeが走っているのが常態のこのホストでは、
# 実測で `session_activity` が `session_created` のまま数時間止まり、画面が動き続けている
# セッションまで「60秒以上 画面が止まっている＝入力待ち」と読まれていた。
# ウィンドウ側の活動時刻はペインの出力で更新されるため、こちらを取る（両者の新しい方を採る）。
tmux_sessions_tsv() {
    local socket="$1" home="$2" tab
    tab="$(printf '\t')"

    {
        # window_activity をコマンド・パスより前に置く。パスに区切り文字が紛れても
        # 時刻の桁がずれないようにするため
        tmux -S "$socket" list-panes -a \
            -F "P${tab}#{session_name}${tab}#{window_active}#{pane_active}${tab}#{window_activity}${tab}#{pane_current_command}${tab}#{pane_current_path}" \
            2> /dev/null || true
        tmux -S "$socket" list-sessions \
            -F "S${tab}#{session_name}${tab}#{session_windows}${tab}#{session_created}${tab}#{session_attached}${tab}#{session_activity}" \
            2> /dev/null || true
    } | awk -F'\t' -v home="$home" -v shells="$TMUX_SHELL_COMMANDS" -v max_commands="$MAX_TMUX_COMMANDS" '
        BEGIN {
            split(shells, shell_list, " ")
            for (i in shell_list) is_shell[shell_list[i]] = 1
            # 区切りにタブを使うと、実行中コマンドが空のセッションで read が
            # 空フィールドを詰めてしまう（タブはIFSの空白文字扱い）。空白でない制御文字を使う
            separator = sprintf("%c", 31)
        }
        $1 == "P" {
            session = $2
            if (!is_shell[$5]) {
                busy[session] = 1
                if (!seen[session "\t" $5] && command_count[session] < max_commands) {
                    seen[session "\t" $5] = 1
                    commands[session] = (commands[session] == "" ? $5 : commands[session] "," $5)
                    command_count[session]++
                }
            }
            # セッションに窓が複数あれば、いちばん新しい活動を採る
            if ($4 + 0 > activity[session]) activity[session] = $4 + 0
            # 出すのはアクティブなウィンドウのアクティブなペイン（＝いま見えている場所）だけ
            if ($3 == "11") path[session] = $6
            next
        }
        $1 == "S" {
            session = $2
            directory = path[session]
            if (home != "" && index(directory, home) == 1) directory = "~" substr(directory, length(home) + 1)
            # 窓の活動（＝画面の動き）とセッションの活動（＝クライアントの操作）の新しい方を最終活動とする
            last_activity = activity[session]
            if ($6 + 0 > last_activity) last_activity = $6 + 0
            printf "%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n", \
                session, separator, $3, separator, $4, separator, $5, separator, last_activity, separator, \
                (busy[session] ? 1 : 0), separator, commands[session], separator, directory
        }
    '
}

# issue-deckが残したセッションの状態を読む（#59）。
#
# 「なぜこのセッションが畳まれずに残っているのか」はtmuxのメタデータからは分からず、
# これまでホストのjournaldを読むしか手が無かった。回収スクリプトは毎分すべてのセッションを
# 判定して理由を持っているが、同じ理由が続く間はログに出さない（同じ行でjournaldが埋まるため）。
#
# 書式は issue-deck の scripts/lib/session-state.sh が持つ1行テキストで、jqを要さずに読める。
# **issue-deck側が置き場を変えたら、この項目が出なくなるだけで送信そのものは壊れない。**
#
# 読んだ値は STATE_* に入れる。呼び出し元は collect_tmux のループの中で、同じシェルにいる。
STATE_HOLD_REASON=""
STATE_HOLD_AT=""
STATE_EVENT_NAME=""
STATE_EVENT_AT=""
STATE_REPOSITORY=""
STATE_ISSUE=""

read_session_state() {
    local session="$1" home="$2" dir file line value

    STATE_HOLD_REASON=""
    STATE_HOLD_AT=""
    STATE_EVENT_NAME=""
    STATE_EVENT_AT=""
    STATE_REPOSITORY=""
    STATE_ISSUE=""

    [ -n "$home" ] || return 0

    # **セッション名を検査してからパスに繋ぐ。** 名前はtmuxから読んだ値がそのまま来ており、
    # 人が手で立てたセッションも混ざる。`../` を含む名前を通すと状態ファイル以外を読みに行ける。
    # 規則は issue-deck の session_state_name_ok と同じ
    case "$session" in
        [A-Za-z0-9]*) ;;
        *) return 0 ;;
    esac
    case "$session" in
        *[!A-Za-z0-9_.-]*) return 0 ;;
    esac

    dir="$home/$SESSION_STATE_SUBDIR"

    # 畳まない理由。**mtimeは「最後に判定した時刻」ではなく「その理由になった時刻」。**
    # 回収スクリプトは理由が変わったときだけ書き直すため、同じ理由が続いた期間が読める
    file="$dir/$session.reason"
    if [ -f "$file" ]; then
        STATE_HOLD_REASON="$(head -1 "$file" 2> /dev/null || true)"
        value="$(stat -c %Y "$file" 2> /dev/null || true)"
        if [ "${value:-0}" -gt 0 ] 2> /dev/null; then
            STATE_HOLD_AT="$(date -u -d "@$value" +%Y-%m-%dT%H:%M:%SZ)"
        fi
    fi

    # Claude Codeのフックが記録した最後のイベント。`<epoch> <イベント名>` の1行
    file="$dir/$session.event"
    if [ -f "$file" ]; then
        line="$(head -1 "$file" 2> /dev/null || true)"
        case "$line" in
            *" "*)
                value="${line%% *}"
                if [ "${value:-0}" -gt 0 ] 2> /dev/null; then
                    STATE_EVENT_AT="$(date -u -d "@$value" +%Y-%m-%dT%H:%M:%SZ)"
                    STATE_EVENT_NAME="${line#* }"
                fi
                ;;
        esac
    fi

    # 対応するIssue。画面からIssueへ飛べるようにする
    file="$dir/$session.session"
    if [ -f "$file" ]; then
        STATE_REPOSITORY="$(sed -n 's/^repository=//p' "$file" 2> /dev/null | head -1)"
        value="$(sed -n 's/^issue=//p' "$file" 2> /dev/null | head -1)"
        case "${value:-}" in
            "" | *[!0-9]*) ;;
            *) STATE_ISSUE="$value" ;;
        esac
    fi
}

# 出力は2行。1行目がセッションのJSON配列、2行目が上限で切る前の総数。
# コマンド置換は subshell で走りグローバル変数を持ち帰れないため、総数も標準出力に載せる。
collect_tmux() {
    local dir socket uid user home count=0 total=0
    local name windows created attached activity busy commands directory
    local attached_json busy_json first_command pane_command
    local command_list

    # tmuxが入っていないホストでは項目ごと送らない（0件との区別をダッシュボード側で付けるため）
    command -v tmux > /dev/null 2>&1 || return 0

    printf '['
    for dir in "$TMUX_SOCKET_ROOT"/tmux-*; do
        [ -d "$dir" ] || continue

        uid="${dir##*/tmux-}"
        case "$uid" in "" | *[!0-9]*) continue ;; esac
        user="$(getent passwd "$uid" 2> /dev/null | cut -d: -f1)"
        home="$(getent passwd "$uid" 2> /dev/null | cut -d: -f6)"
        [ -n "$user" ] || user="uid:$uid"

        for socket in "$dir"/*; do
            [ -S "$socket" ] || continue

            # サーバーが落ちた後のソケットが残っていることがあるため、失敗は無視して次へ
            while IFS=$'\x1f' read -r name windows created attached activity busy commands directory; do
                [ -n "$name" ] || continue

                # 上限を超えた分は送らないが、総数には数える。
                # 「20件しか出ていないのは上限のせいなのか、本当に20件なのか」が
                # 画面から分からないと、セッションが積み上がっていることに気づけない
                total=$((total + 1))
                [ "$count" -lt "$MAX_TMUX_SESSIONS" ] || continue

                read_session_state "$name" "$home"

                [ "$count" -eq 0 ] || printf ','
                count=$((count + 1))

                if [ "${attached:-0}" -gt 0 ] 2> /dev/null; then
                    attached_json=true
                else
                    attached_json=false
                fi

                if [ "${busy:-0}" = "1" ]; then
                    busy_json=true
                else
                    busy_json=false
                fi

                printf '{"name":"%s","windows":%d,"attached":%s,"busy":%s,"user":"%s"' \
                    "$(json_escape "$name")" "${windows:-0}" "$attached_json" "$busy_json" \
                    "$(json_escape "$user")"

                if [ -n "$commands" ]; then
                    IFS=',' read -r -a command_list <<< "$commands"
                    printf ',"commands":['
                    first_command=1
                    for pane_command in "${command_list[@]}"; do
                        [ -n "$pane_command" ] || continue
                        [ "$first_command" -eq 1 ] || printf ','
                        first_command=0
                        printf '"%s"' "$(json_escape "$pane_command")"
                    done
                    printf ']'
                fi

                if [ -n "$directory" ]; then
                    printf ',"path":"%s"' "$(json_escape "$directory")"
                fi

                if [ "${created:-0}" -gt 0 ] 2> /dev/null; then
                    printf ',"createdAt":"%s"' "$(date -u -d "@$created" +%Y-%m-%dT%H:%M:%SZ)"
                fi

                # 放置セッションの判定に使う。世代の古いtmuxでは数値で返らないことがあり、その場合は送らない
                if [ "${activity:-0}" -gt 0 ] 2> /dev/null; then
                    printf ',"lastActivityAt":"%s"' "$(date -u -d "@$activity" +%Y-%m-%dT%H:%M:%SZ)"
                fi

                # issue-deckの回収が残した判断（#59）。手で立てたセッションには何も無い
                if [ -n "$STATE_HOLD_REASON" ]; then
                    printf ',"holdReason":"%s"' "$(json_escape "$STATE_HOLD_REASON")"
                    [ -z "$STATE_HOLD_AT" ] || printf ',"holdReasonAt":"%s"' "$STATE_HOLD_AT"
                fi
                if [ -n "$STATE_EVENT_NAME" ]; then
                    printf ',"lastEventName":"%s","lastEventAt":"%s"' \
                        "$(json_escape "$STATE_EVENT_NAME")" "$STATE_EVENT_AT"
                fi
                if [ -n "$STATE_REPOSITORY" ] && [ -n "$STATE_ISSUE" ]; then
                    printf ',"issueRepository":"%s","issueNumber":%d' \
                        "$(json_escape "$STATE_REPOSITORY")" "$STATE_ISSUE"
                fi

                printf '}'
            done < <(tmux_sessions_tsv "$socket" "$home")
        done
    done
    printf ']\n%d' "$total"
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
    local swap temperature tmux_output tmux_sessions tmux_total
    collect_samples
    swap="$(collect_swap)"
    temperature="$(collect_temperature)"

    # collect_tmux は「1行目がJSON配列・2行目が総数」を返す。JSONに改行は入らないため行で切れる。
    # tmuxが入っていないホストでは何も返らず、両方とも空になる
    tmux_output="$(collect_tmux)"
    tmux_sessions="${tmux_output%%$'\n'*}"
    tmux_total="${tmux_output#*$'\n'}"

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
    printf '"topProcesses":%s,' "$(top_processes_json -pcpu 2)"
    printf '"topMemoryProcesses":%s,' "$(top_processes_json -rss 3)"
    printf '"maintenance":%s,' "$(collect_maintenance)"
    printf '"sessions":%s,' "$(collect_sessions)"
    [ -z "$tmux_sessions" ] || printf '"tmuxSessions":%s,' "$tmux_sessions"
    [ -z "$tmux_sessions" ] || printf '"tmuxSessionTotal":%d,' "$tmux_total"
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
