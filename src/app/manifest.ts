import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StatusHub",
    short_name: "StatusHub",
    description: "VPS稼働状況・UptimeRobot・Uptime Kuma監視ダッシュボード",
    start_url: "/",
    display: "standalone",
    background_color: "#071B38",
    theme_color: "#071B38",
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
      // maskableは端末側が円などで切り抜くため、外周の角丸を焼き込まない画像を渡す。
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
