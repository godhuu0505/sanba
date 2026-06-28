import "./globals.css";
import "@livekit/components-styles";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Noto_Serif_JP } from "next/font/google";

import { AuthProvider } from "@/lib/auth";

// SANBA 体験の地の書体。産婆術の世界観に合わせた明朝。CSS 変数として配り、
// SANBA デザインシステム（components/sanba/*）だけが .sanba-font で参照する。
// light テーマの admin/login は従来どおり system-ui を使い続ける。
const notoSerifJp = Noto_Serif_JP({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-serif-jp",
});

export const metadata: Metadata = {
  title: "SANBA — 解像度高く、要件を生み出す",
  description: "Voice multi-agent that interviews you to bring your requirements into focus.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={notoSerifJp.variable}>
      <body className="m-0 min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
