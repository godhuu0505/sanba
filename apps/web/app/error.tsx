"use client";

import { useEffect } from "react";

import { AppHeader, Button, Card, CardTitle, Screen } from "@/components/sanba";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  const isChunkError = /ChunkLoadError|Loading chunk|importing a module script failed/i.test(
    error.message,
  );

  return (
    <Screen>
      <AppHeader />
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
        <p className="mb-2 text-[12px] tracking-[0.2em] text-sanba-gold-text">
          エラー
        </p>
        <Card>
          <CardTitle>
            {isChunkError ? "新しいバージョンがあります" : "問題が発生しました"}
          </CardTitle>
          <p className="text-[13px] leading-relaxed text-sanba-muted">
            {isChunkError
              ? "新しいバージョンに更新されました。再読み込みしてください。"
              : "予期しないエラーが発生しました。お手数ですが、もう一度お試しください。"}
          </p>
          {error.message && (
            <p className="break-all rounded-[10px] border border-sanba-border bg-sanba-bg/40 px-[12px] py-[10px] text-[12px] text-sanba-cream">
              {error.message}
              {error.digest ? ` (digest: ${error.digest})` : ""}
            </p>
          )}
          <div className="flex gap-[8px]">
            <Button variant="gold" onClick={() => reset()}>
              もう一度試す
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              再読み込み
            </Button>
          </div>
        </Card>
      </div>
    </Screen>
  );
}
