"use client";

// 認証ゲート（ADR-0012 / docs/design/conversation-experience-v2.md §3 横断）。
// 未ログインで保護ルート（会話フェーズ等）に来たら /login?next= へリダイレクトする。
// 認証解決前（ready=false）は何も描画せずリダイレクトもしない（解決待ち）。
// ログイン後は next で元の遷移先へ復帰する想定（/login 側が next を読む）。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export interface RequireAuthProps {
  /** 認証状態が解決済みか（GIS の再取得待ちなどが終わったか）。false の間はリダイレクトしない。 */
  ready: boolean;
  /** ログイン済みか。 */
  loggedIn: boolean;
  /** ログイン後に戻る遷移先（/login?next= に載せる）。 */
  next: string;
  children: React.ReactNode;
}

export function RequireAuth({ ready, loggedIn, next, children }: RequireAuthProps) {
  const router = useRouter();

  useEffect(() => {
    if (ready && !loggedIn) {
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [ready, loggedIn, next, router]);

  // 解決前・未ログイン確定（リダイレクト中）は保護コンテンツを出さない。
  if (!ready || !loggedIn) return null;
  return <>{children}</>;
}
