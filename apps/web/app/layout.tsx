import "./globals.css";
import "@livekit/components-styles";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Noto_Sans_JP, Noto_Serif_JP, Zen_Kaku_Gothic_New } from "next/font/google";

import { AuthProvider } from "@/lib/auth";

// SANBA 体験の地の書体（ADR-0025「白い紙の上の問答」）。
//  - 地・UI: Noto Sans JP（.sanba-font）
//  - 見出し・ロゴ: Zen Kaku Gothic New（.sanba-display）
//  - 産章の一字のみ明朝を残す: Noto Serif JP（.sanba-serif）
// CSS 変数として配り、globals.css のユーティリティが参照する。
const notoSansJp = Noto_Sans_JP({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-sans-jp",
});

const zenKakuGothicNew = Zen_Kaku_Gothic_New({
  weight: ["700", "900"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-zen-kaku",
});

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
    <html
      lang="ja"
      className={`${notoSansJp.variable} ${zenKakuGothicNew.variable} ${notoSerifJp.variable}`}
    >
      <body className="m-0 min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
