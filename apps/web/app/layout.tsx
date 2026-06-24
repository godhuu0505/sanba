import "./globals.css";
import "@livekit/components-styles";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "SANBA — 解像度高く、要件を生み出す",
  description: "Voice multi-agent that interviews you to bring your requirements into focus.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="m-0 min-h-screen">{children}</body>
    </html>
  );
}
