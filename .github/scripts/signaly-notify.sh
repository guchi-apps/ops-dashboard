#!/usr/bin/env bash
# Signaly CI / デプロイ通知スクリプト（GitHub Actions 用）
#
# 手順の詳細: ../_docs/README.md（CI / デプロイ通知セクション）
# 各アプリの .github/scripts/ にコピーして使用する。
#
# Requires: SIGNALY_WEBHOOK_URL, NOTIFY_STATUS (success|failure|cancelled)
# Optional: NOTIFY_APP, NOTIFY_KIND (e.g. デプロイ / CI), NOTIFY_JOB, NOTIFY_VERSION (リリース時)
set -euo pipefail

if [[ -z "${SIGNALY_WEBHOOK_URL:-}" ]]; then
  echo "SIGNALY_WEBHOOK_URL not set; skipping Signaly notification"
  exit 0
fi

status="${NOTIFY_STATUS:-unknown}"
app_name="${NOTIFY_APP:-}"
kind="${NOTIFY_KIND:-}"
workflow_name="${NOTIFY_WORKFLOW:-${GITHUB_WORKFLOW:-GitHub Actions}}"
job_name="${NOTIFY_JOB:-${GITHUB_JOB:-}}"
version="${NOTIFY_VERSION:-}"
repository="${GITHUB_REPOSITORY:-}"
ref_name="${GITHUB_REF_NAME:-}"
sha="${GITHUB_SHA:-}"
sha_short="${sha:0:7}"
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

case "$status" in
  success)
    emoji="✅"
    color="#57f287"
    status_label="成功"
    ;;
  failure)
    emoji="❌"
    color="#ed4245"
    status_label="失敗"
    ;;
  cancelled)
    emoji="⚪"
    color="#95a5a6"
    status_label="キャンセル"
    ;;
  *)
    emoji="ℹ️"
    color="#5865f2"
    status_label="$status"
    ;;
esac

if [[ -n "$app_name" && -n "$kind" ]]; then
  if [[ "$kind" == "リリース" && -n "$version" ]]; then
    title="${emoji} [${app_name}] ${kind} ${version} ${status_label}"
  else
    title="${emoji} [${app_name}] ${kind} ${status_label}"
  fi
elif [[ -n "$app_name" ]]; then
  title="${emoji} [${app_name}] ${workflow_name} ${status_label}"
else
  title="${emoji} ${workflow_name} ${status_label}"
fi

export NOTIFY_STATUS="$status"
export NOTIFY_APP="$app_name"
export NOTIFY_KIND="$kind"
export NOTIFY_WORKFLOW="$workflow_name"
export NOTIFY_JOB="$job_name"
export NOTIFY_VERSION="$version"
export REPOSITORY="$repository"
export SHA_SHORT="$sha_short"
export RUN_URL="$run_url"
export COLOR="$color"
export TITLE="$title"

payload=$(python3 - <<'PY'
import json
import os

app_name = os.environ.get("NOTIFY_APP", "")
kind = os.environ.get("NOTIFY_KIND", "")
version = os.environ.get("NOTIFY_VERSION", "")
job_name = os.environ.get("NOTIFY_JOB", "")
event_name = os.environ.get("GITHUB_EVENT_NAME", "")
repository = os.environ.get("REPOSITORY", "")
ref_name = os.environ.get("GITHUB_REF_NAME", "")
sha_short = os.environ.get("SHA_SHORT", "")
actor = os.environ.get("GITHUB_ACTOR", "")
run_url = os.environ.get("RUN_URL", "")
color = os.environ["COLOR"]
title = os.environ["TITLE"]

fields = []
if app_name:
    fields.append({"name": "App", "value": app_name, "inline": True})
if kind:
    fields.append({"name": "Type", "value": kind, "inline": True})
if version:
    fields.append({"name": "Version", "value": f"`{version}`", "inline": True})
if repository:
    fields.append({"name": "Repository", "value": f"`{repository}`", "inline": True})
if ref_name:
    fields.append({"name": "Branch", "value": ref_name, "inline": True})
if sha_short:
    fields.append({"name": "Commit", "value": f"`{sha_short}`", "inline": True})
if actor:
    fields.append({"name": "Actor", "value": actor, "inline": True})
if job_name:
    fields.append({"name": "Job", "value": job_name, "inline": True})
if event_name:
    fields.append({"name": "Event", "value": event_name, "inline": True})
fields.append({"name": "Run", "value": f"[Workflow Run]({run_url})", "inline": False})

print(json.dumps({
    "title": title,
    "color": color,
    "fields": fields,
}))
PY
)

curl -fsS \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$SIGNALY_WEBHOOK_URL"
