import "./globals.css";
import "@livekit/components-styles";
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
