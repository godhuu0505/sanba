"use client";

// 認証ゲート（ADR-0012 / docs/design/conversation-experience.md §3 横断）。
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
  /** 認証済みのとき描画する保護コンテンツ。ガード用途（未ログイン時のみマウント）では省略可。 */
  children?: React.ReactNode;
}

/** authGate が参照する認証状態の最小サブセット（useGoogleAuth の戻り値の一部）。 */
type GateAuth = { devMode: boolean; ready: boolean; loggedIn: boolean };

/**
 * 厳密な認証ゲート（全画面保護）の共通判定。各保護ページで重複していた条件を一本化する。
 * - dev モード（GOOGLE_CLIENT_ID 未設定）: API の AUTH_DEV_BYPASS に委ねて素通し → null。
 * - 認証済み（ready かつ loggedIn）: 保護コンテンツを描かせる → null。
 * - それ以外（未ログイン / 解決前）: /login?next= へ戻す RequireAuth 要素を返す。
 *
 * 使い方: `const gate = authGate(auth, "/"); if (gate) return gate;`
 * （useGoogleAuth を二重に呼ばないよう、呼び出し側の auth をそのまま渡す）。
 */
export function authGate(auth: GateAuth, next: string): React.ReactElement | null {
  if (auth.devMode) return null;
  if (auth.ready && auth.loggedIn) return null;
  return <RequireAuth ready={auth.ready} loggedIn={auth.loggedIn} next={next} />;
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
