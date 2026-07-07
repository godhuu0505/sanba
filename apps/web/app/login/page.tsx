"use client";


import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { BrandMark, BrandSplash, Button, Screen } from "@/components/sanba";
import { useAuth } from "@/lib/auth";

export function safeNextPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

export default function LoginPage() {
  const { loggedIn, ready, devMode, buttonRef, devSignIn, signOut, resetButton } = useAuth();

  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const loggedOutRef = useRef<boolean | null>(null);
  if (loggedOutRef.current === null) {
    loggedOutRef.current =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("loggedOut") === "1";
  }

  const nextRef = useRef<string | null>(null);
  useEffect(() => {
    nextRef.current = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    if (loggedOutRef.current) {
      signOut();
      window.history.replaceState(window.history.state, "", "/login");
    }
  }, [signOut]);

  useEffect(() => {
    if (loggedOutRef.current) {
      if (!loggedIn) loggedOutRef.current = false;
      return;
    }
    if (loggedIn) routerRef.current.replace(nextRef.current ?? "/");
  }, [loggedIn]);

  const showSignIn = ready && !loggedIn;
  useEffect(() => {
    if (showSignIn && !devMode) resetButton();
  }, [showSignIn, devMode, resetButton]);

  if (!ready || loggedIn) return <BrandSplash />;

  return (
    <Screen className="items-center justify-center px-6 py-10">
      <main
        aria-label="ログイン"
        className="flex w-full max-w-xs flex-col items-center gap-9 text-center"
      >
        <div className="flex flex-col items-center gap-4">
          {}
          <BrandMark className="h-24 w-auto" aria-hidden />
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="sanba-display text-[28px] font-bold tracking-[0.08em] text-sanba-cream">
              SANBA
            </h1>
            <p className="text-[13px] leading-relaxed text-sanba-muted">
              解像度高く、要件を生み出す
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          {devMode ? (
            <Button variant="gold" block onClick={devSignIn}>
              開発用ログイン（bypass）
            </Button>
          ) : (
            <div ref={buttonRef} className="flex min-h-[44px] w-full justify-center" />
          )}
          <p className="text-[11px] leading-relaxed text-sanba-muted">
            {devMode
              ? "※ 開発モード（GOOGLE_CLIENT_ID 未設定）。API の AUTH_DEV_BYPASS で通します。"
              : "Google アカウントで本人確認します。メールアドレスとパスワードの入力は不要です。"}
          </p>
        </div>
      </main>
    </Screen>
  );
}
