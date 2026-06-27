"use client";

// ログイン／ログアウト ユースケース (ADR-0014 §1 / Figma 正本 31:2・黄金テーマ 73-3..6)。
// 4 状態の一本道: 11 未認証 → 12 サインイン中 → 13 ログイン済み導線 → 14 ログアウト完了。
//
// 認証ロジックと認可（管理者判定は API 側の ADMIN_EMAILS が源泉）は変えず、意匠とフローのみ
// 拡張する (CLAUDE.md「スキン」方針)。SANBA デザインシステム（components/sanba/*）を再利用。
// GIS は「サインイン開始」イベントを出さないため、12 は loggedIn の false→true 立ち上がりを
// 契機に短時間だけ見せ、自動で 13 へ送る。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Card, CardDescription, CardTitle, Divider, Logo, Screen } from "@/components/sanba";
import { useGoogleAuth } from "@/lib/auth";

// 12「本人確認中」を見せる時間。実機・dev とも同じ間で 13 へ遷移する。
const WELCOME_MS = 1000;

// `?next=` はユーザー操作で渡る値なので、同一オリジンの相対パスだけを許可する
// （オープンリダイレクト／`javascript:` スキーム XSS の防止）。
// 許可: "/" 始まりで "//"・"/\" でないパス。それ以外は null（既定ルートに留める）。
export function safeNextPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

export default function LoginPage() {
  const { loggedIn, profile, devMode, buttonRef, devSignIn, signOut, resetButton } = useGoogleAuth();

  const [justLoggedOut, setJustLoggedOut] = useState(false);
  const [welcoming, setWelcoming] = useState(false);
  const prevLoggedIn = useRef(loggedIn);

  // 保護ルート（RequireAuth）から ?next= 付きで来たら、ログイン後に元の遷移先へ復帰する。
  // welcome（12）の表示を挟んでから遷移するため、loggedIn 立ち上がりの WELCOME_MS 後に replace。
  const router = useRouter();
  const nextRef = useRef<string | null>(null);
  useEffect(() => {
    nextRef.current = safeNextPath(new URLSearchParams(window.location.search).get("next"));
  }, []);
  useEffect(() => {
    if (!loggedIn || !nextRef.current) return;
    const target = nextRef.current;
    const t = setTimeout(() => router.replace(target), WELCOME_MS);
    return () => clearTimeout(t);
  }, [loggedIn, router]);

  // loggedIn が false→true に立ち上がった時だけ 12 を見せる。マウント時点で既に loggedIn
  // (auto_select による静かな再取得) なら立ち上がり扱いせず 13 へ直行する。
  useEffect(() => {
    if (loggedIn && !prevLoggedIn.current) {
      prevLoggedIn.current = true;
      setWelcoming(true);
      const t = setTimeout(() => setWelcoming(false), WELCOME_MS);
      return () => clearTimeout(t);
    }
    prevLoggedIn.current = loggedIn;
  }, [loggedIn]);

  function handleLogout() {
    signOut();
    setWelcoming(false);
    setJustLoggedOut(true);
  }

  // 12 のキャンセル（Figma 75:14）。本人確認の待ちを取りやめ、サインアウトして 11 未認証へ戻す。
  function handleCancelSignIn() {
    setWelcoming(false);
    signOut();
  }

  // ── 14 ログアウト完了 ──────────────────────────────────────────
  if (justLoggedOut) {
    return (
      <Screen className="items-center justify-center px-6 py-10 text-center">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
          <p className="text-[13px] tracking-[0.4em] text-[var(--sanba-gold-text)]">
            ✦ またのお越しを ✦
          </p>
          <h1 className="text-[30px] font-bold text-[var(--sanba-gold-text)]">
            おつかれさまでした
          </h1>
          <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            ログアウトしました。問答の記録は安全に保たれています。
          </p>
          <Button variant="outline" className="mt-3" onClick={() => { setJustLoggedOut(false); resetButton(); }}>
            再びログインする
          </Button>
        </div>
      </Screen>
    );
  }

  // ── 12 サインイン中（本人確認） ────────────────────────────────
  if (loggedIn && welcoming) {
    return (
      <Screen className="items-center justify-center px-6 py-10 text-center">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4">
          {/* ロゴヘッダー（Figma 75:6）。 */}
          <Logo size="lg" />
          <div
            role="status"
            aria-label="本人確認中"
            className="size-16 animate-spin rounded-full border-4 border-[var(--sanba-border)] border-t-[var(--sanba-gold)]"
          />
          <p className="text-[17px] font-bold text-[var(--sanba-cream)]">
            Google アカウントを確認しています
          </p>
          <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            本人確認のため、Google のポップアップでアカウントを選択してください。
          </p>
          {/* キャンセル（Figma 75:14）。待ちを取りやめて 11 未認証へ戻す。 */}
          <Button variant="ghost" className="mt-2" onClick={handleCancelSignIn}>
            キャンセル
          </Button>
        </div>
      </Screen>
    );
  }

  // ── 13 ログイン済み（導線） ────────────────────────────────────
  if (loggedIn) {
    return (
      <Screen className="justify-center px-6 py-10">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-4 flex flex-col gap-1.5">
            <h1 className="text-[24px] font-bold text-[var(--sanba-gold-text)]">
              ようこそ戻られました
            </h1>
            <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
              問答を始めるも、要件を検めるも、御心のままに。
            </p>
          </div>
          <Card>
            <CardTitle>🎙️ SANBA にログイン</CardTitle>
            <p className="text-[13px] text-[var(--sanba-cream)]">
              ✅ ログイン中: <strong>{profile?.email ?? "dev@sanba.local"}</strong>
            </p>
            <Button asChild variant="gold" block>
              <Link href="/">🎙️ インタビューを始める</Link>
            </Button>
            <Button asChild variant="outline" block>
              <Link href="/admin">🛠 管理画面へ</Link>
            </Button>
            <Divider />
            <Button variant="ghost" className="self-start" onClick={handleLogout}>
              ログアウト
            </Button>
          </Card>
        </div>
      </Screen>
    );
  }

  // ── 11 未認証 ──────────────────────────────────────────────────
  return (
    <Screen className="justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-4 flex flex-col gap-1.5">
          <h1 className="text-[24px] font-bold text-[var(--sanba-gold-text)]">
            問答の間へ、ようこそ
          </h1>
          <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            声で要件を産み出す前に、まずは本人を確かめます。
          </p>
        </div>
        <Card>
          <CardTitle>🎙️ SANBA にログイン</CardTitle>
          <CardDescription>
            解像度高く、要件を生み出す音声マルチエージェント。Google アカウントで本人確認します。
          </CardDescription>
          {devMode ? (
            <Button variant="gold" block onClick={devSignIn}>
              開発用ログイン（bypass）
            </Button>
          ) : (
            // GIS がこの div に純正のサインインボタンを描画する。
            <div ref={buttonRef} className="flex justify-center" />
          )}
          <p className="text-[11px] leading-relaxed text-[var(--sanba-muted)]">
            {devMode
              ? "※ 開発モード（GOOGLE_CLIENT_ID 未設定）。API の AUTH_DEV_BYPASS で通します。"
              : "※ 未ログイン時は Google のサインインがこの位置に開きます。"}
          </p>
        </Card>
      </div>
    </Screen>
  );
}
