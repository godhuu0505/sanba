"use client";

// ルートのエラー境界 (App Router)。これが無いと未捕捉の例外で Next 既定の
// 「This page couldn't load」だけが出て原因が分からない。SANBA 意匠で実エラーを
// 見せ、再試行と再読込（チャンク不整合＝古いタブ対策）の導線を出す。

import { useEffect } from "react";

import { Button, Card, CardTitle, Screen } from "@/components/sanba";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 観測性: クライアント例外をコンソールへ。将来 Sentry/OTel に送る土台。
    console.error("[app/error]", error);
  }, [error]);

  // ビルド更新で旧チャンクが 404 になる典型は名前で判別できる。再読込で直る。
  const isChunkError = /ChunkLoadError|Loading chunk|importing a module script failed/i.test(
    error.message,
  );

  return (
    <Screen className="items-center justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <p className="mb-2 text-[12px] tracking-[0.2em] text-[var(--sanba-gold-text)]">
          ✦ しくじり ✦
        </p>
        <Card>
          <CardTitle>
            {isChunkError ? "新しい版が出ております" : "問答の間で支障が生じました"}
          </CardTitle>
          <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            {isChunkError
              ? "画面の版が更新されました。再読込でお直りいたします。"
              : "予期せぬ支障が生じました。お手数ですが再度お試しください。"}
          </p>
          {error.message && (
            <p className="break-all rounded-[10px] border border-[var(--sanba-border)] bg-[var(--sanba-bg)]/40 px-[12px] py-[10px] text-[12px] text-[var(--sanba-cream)]">
              {error.message}
              {error.digest ? ` (digest: ${error.digest})` : ""}
            </p>
          )}
          <div className="flex gap-[8px]">
            <Button variant="gold" onClick={() => reset()}>
              再び試みる
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              再読込する
            </Button>
          </div>
        </Card>
      </div>
    </Screen>
  );
}
