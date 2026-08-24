import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ops-dashboard",
    short_name: "ops-dashboard",
    description: "VPS稼働状況・UptimeRobot・Uptime Kuma監視ダッシュボード",
    start_url: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#020617",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // maskableは端末側が円などで切り抜くため、四隅まで地色を敷いた専用の画像を渡す。
      // anyと同じ角丸の画像を渡すと、角が二重に削れて小さく見える（#164）。
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
