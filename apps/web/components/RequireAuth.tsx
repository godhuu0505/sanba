"use client";

// 認証ゲート（ADR-0012 / docs/reference/conversation-experience.md §3 横断）。
// 未ログインで保護ルート（会話フェーズ等）に来たら /login?next= へリダイレクトする。
// 認証解決前（ready=false）はリダイレクトせず「確認中」を表示して解決を待つ
// （ログイン痕跡があるブラウザでは auth 側が復元を長めに待つため、空白ではなく状態を見せる）。
// 復元できればそのまま保護コンテンツを描画する＝ログイン済みなら /login を経由せず
// アクセスした URL に直接入れる。ログイン後は next で元の遷移先へ復帰する想定（/login 側が next を読む）。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { Screen } from "@/components/sanba";

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

  // 解決前は保護コンテンツを出さず「確認中」を見せる（/login の確認中表示と同じ意匠）。
  // 復元が済めばこのままアクセス先の画面を描画し、/login への往復を挟まない。
  if (!ready) {
    return (
      <Screen className="items-center justify-center gap-4 text-center">
        <div
          role="status"
          aria-label="ログイン状態を確認中"
          className="size-16 animate-spin rounded-full border-4 border-sanba-border border-t-sanba-gold"
        />
        <p className="text-[13px] leading-relaxed text-sanba-muted">
          ログイン状態を確認しています…
        </p>
      </Screen>
    );
  }
  // 未ログイン確定（リダイレクト中）は何も出さない。
  if (!loggedIn) return null;
  return <>{children}</>;
}
