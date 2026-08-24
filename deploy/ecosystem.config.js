const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "ops-dashboard",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: path.resolve(__dirname, ".."),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // メモリ2GBのVPS上でNext.jsが10本常駐しており、Nodeの既定ヒープ上限
      // （1プロセスあたり約1006MB）ではGCが働かず各プロセスが数百MBを抱え込む。
      // 上限を明示して早めにGCさせる。max_memory_restart は暴走時の保険。
      // 詳細: https://github.com/guchi-apps/vps/issues/62
      node_args: "--max-old-space-size=128",
      max_memory_restart: "320M",
      // PM2 は max_memory_restart による再起動やサーバー再起動後の resurrect で
      // プロセスを起動し直す際、pm2 start 時に指定した --env production を失って
      // 既定の env にフォールバックすることがある。development で起動されると
      // Apache のプロキシ先（127.0.0.1:3110）と食い違って 503 になるため、
      // 既定の env も本番と同じ値にしておく。
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3110,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3110,
      },
    },
  ],
};
