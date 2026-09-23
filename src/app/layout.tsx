import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppFooter } from "@/components/app-footer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StatusHub",
  description: "VPS稼働状況・UptimeRobot・Uptime Kuma監視ダッシュボード",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "StatusHub",
  },
  icons: {
    // SVGを先に置く。対応ブラウザはタブの小さいサイズでも輪郭がぼやけない（#164）
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOSは透過部分を黒で塗るため、角丸を付けず全面を地色で塗った画像を渡す
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: "#071B38",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen flex flex-col">
        {/* iOS 27のPWAが自動で付けるブラーを止めるダミー要素（globals.css参照・#361）。
            何も描画しないため位置は先頭でなくてよいが、他の要素より前にしておく。 */}
        <div aria-hidden="true" className="ios-status-bar-blur-fix" />
        {children}
        <AppFooter />
      </body>
    </html>
  );
}
