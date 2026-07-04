import "./globals.css";
import "@livekit/components-styles";
// SANBA 体験の地の書体（ADR-0025「白い紙の上の問答」）を自前配信（セルフホスト）する。
// 以前は next/font/google でビルド時に Google Fonts から取得していたが、日本語書体は
// 数百のサブセットファイルを一括DLするためビルドが重く・不安定だった。@fontsource で
// woff2 を node_modules から同梱し、ビルド時のネットワーク依存を無くす。
//  - 地・UI: Noto Sans JP（.sanba-font / 400・700）
//  - 見出し・ロゴ: Zen Kaku Gothic New（.sanba-display / 700・900）
//  - 産章の一字のみ明朝を残す: Noto Serif JP（.sanba-serif / 400・700）
// font-family 名（"Noto Sans JP" 等）は globals.css の --font-* が参照する。
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/700.css";
import "@fontsource/zen-kaku-gothic-new/700.css";
import "@fontsource/zen-kaku-gothic-new/900.css";
import "@fontsource/noto-serif-jp/400.css";
import "@fontsource/noto-serif-jp/700.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "SANBA — 解像度高く、要件を生み出す",
  description: "Voice multi-agent that interviews you to bring your requirements into focus.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="m-0 min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
