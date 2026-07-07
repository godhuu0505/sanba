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
          ✦ しくじり ✦
        </p>
        <Card>
          <CardTitle>
            {isChunkError ? "新しい版が出ております" : "問答の間で支障が生じました"}
          </CardTitle>
          <p className="text-[13px] leading-relaxed text-sanba-muted">
            {isChunkError
              ? "画面の版が更新されました。再読込でお直りいたします。"
              : "予期せぬ支障が生じました。お手数ですが再度お試しください。"}
          </p>
          {error.message && (
            <p className="break-all rounded-[10px] border border-sanba-border bg-sanba-bg/40 px-[12px] py-[10px] text-[12px] text-sanba-cream">
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
