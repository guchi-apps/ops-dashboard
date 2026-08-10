# Vault: apps — ops-dashboard / Server / githubaction-sshkey / Supabase
SSH_PRIVATE_KEY=op://apps/githubaction-sshkey/private_key?ssh-format=openssh
HOST=op://apps/Server/host
USERNAME=op://apps/Server/username
SSH_PORT=op://apps/Server/ssh-port
TARGET_DIR=op://apps/ops-dashboard/target-dir
PORT=op://apps/ops-dashboard/port

# Auth（Supabaseは複数アプリ共通プロジェクトのため Vault は共有アイテムを参照）
NEXT_PUBLIC_SUPABASE_URL=op://apps/Supabase/project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=op://apps/Supabase/publishable-key
ALLOWED_EMAILS=op://apps/ops-dashboard/allowed-emails

# 監視対象
UPTIMEROBOT_READ_ONLY_KEY=op://apps/ops-dashboard/uptimerobot-read-only-key
UPTIMEKUMA_BASE_URL=op://apps/ops-dashboard/uptimekuma-base-url
UPTIMEKUMA_DASHBOARD_SLUG=op://apps/ops-dashboard/uptimekuma-dashboard-slug
SYSTEM_STATS_DISK_PATH=op://apps/ops-dashboard/system-stats-disk-path

# CI / デプロイ通知
SIGNALY_WEBHOOK_URL=op://apps/ops-dashboard/ci-webhook-url

# ログイン通知
SIGNALY_LOGIN_WEBHOOK_URL=op://apps/ops-dashboard/login-webhook-url

# AI使用状況（それぞれ各CLIのログイン情報にあるリフレッシュトークン）
ANTHROPIC_OAUTH_REFRESH_TOKEN=op://apps/ops-dashboard/anthropic-oauth-refresh-token
OPENAI_CHATGPT_REFRESH_TOKEN=op://apps/ops-dashboard/openai-chatgpt-refresh-token
OPENAI_CHATGPT_ACCOUNT_ID=op://apps/ops-dashboard/openai-chatgpt-account-id
