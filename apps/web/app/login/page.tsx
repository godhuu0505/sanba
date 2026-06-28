"use client";

// ログイン／ログアウト ユースケース (ADR-0014 §1 / Figma 正本 31:2・黄金テーマ 73-3..6)。
// 状態の一本道: 11 未認証 → 12 サインイン中 →（ログイン後はホーム / へ誘導）。
// ログアウト完了の挨拶（14）は、ホームのアカウントメニュー（#217）から ?loggedOut=1 で来た時に出す。
//
// 認証ロジックと認可（管理者判定は API 側の ADMIN_EMAILS が源泉）は変えず、意匠とフローのみ
// 拡張する (CLAUDE.md「スキン」方針)。SANBA デザインシステム（components/sanba/*）を再利用。
// GIS は「サインイン開始」イベントを出さないため、12 は loggedIn の false→true 立ち上がりを
// 契機に短時間だけ見せ、自動でホームへ送る。ログイン後の導線は /login 内に持たず、Figma 正本に
// 倣ってホーム＋アカウントメニューへ集約した（監査 B-1 #1/#5）。

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Card, CardDescription, CardTitle, Logo, Screen } from "@/components/sanba";
import { useAuth } from "@/lib/auth";

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
  const { loggedIn, devMode, buttonRef, devSignIn, signOut, resetButton } = useAuth();

  const [justLoggedOut, setJustLoggedOut] = useState(false);
  const [welcoming, setWelcoming] = useState(false);
  const prevLoggedIn = useRef(loggedIn);

  const router = useRouter();
  // router を ref に退避し、遷移 effect の依存から外す（useRouter は再描画ごとに別インスタンスを
  // 返し得るため、依存に入れると welcome 表示中に遷移 effect が再実行され即時遷移してしまう）。
  const routerRef = useRef(router);
  routerRef.current = router;

  // ログアウト遷移（?loggedOut=1）はマウント初回レンダーで同期確定させる。state(justLoggedOut)
  // の反映前に遷移 effect が走って home へ送ってしまうレースを防ぐため、遷移 effect でも参照する。
  const loggedOutRef = useRef<boolean | null>(null);
  if (loggedOutRef.current === null) {
    loggedOutRef.current =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("loggedOut") === "1";
  }

  // 保護ルート（RequireAuth）から ?next= 付きで来たら、ログイン後に元の遷移先へ復帰する。
  const nextRef = useRef<string | null>(null);
  useEffect(() => {
    nextRef.current = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    // ?loggedOut=1（アカウントメニューからのログアウト遷移）はここで実際に signOut する
    // （共有 credential を clear＋auto_select 無効化）。元ページ側で signOut しないことで
    // authGate の誤リダイレクトと競合しない（Codex P2）。14 ゴールを表示する。
    if (loggedOutRef.current) {
      setJustLoggedOut(true);
      signOut();
    }
    // root の AuthProvider が先に GIS を初期化済みで、この画面の buttonRef は未装着だったため
    // 純正サインインボタンが描画されない。マウント後に再描画を促して buttonRef へ描画させる。
    resetButton();
  }, [signOut, resetButton]);

  // ログイン後はホーム（or ?next）へ送る。13「ナビハブ」は廃止し、導線はホームのアカウント
  // メニューへ集約した（監査 B-1 #5）。loggedIn の false→true 立ち上がり時は 12（本人確認中）を
  // WELCOME_MS だけ見せてから遷移する。マウント時点で既に loggedIn（auto_select の静かな再取得）
  // なら立ち上がり扱いせず即遷移する。キャンセル/ログアウトで loggedIn が落ちたら cleanup で
  // 保留中のタイマーを破棄する。
  useEffect(() => {
    if (loggedOutRef.current || justLoggedOut) return;
    if (!loggedIn) {
      prevLoggedIn.current = false;
      return;
    }
    const go = () => routerRef.current.replace(nextRef.current ?? "/");
    if (!prevLoggedIn.current) {
      prevLoggedIn.current = true;
      setWelcoming(true);
      const t = setTimeout(() => {
        setWelcoming(false);
        go();
      }, WELCOME_MS);
      return () => clearTimeout(t);
    }
    go();
  }, [loggedIn, justLoggedOut]);

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
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => {
              // 以後はログイン後ホーム誘導を再び有効化する（loggedOut ガードを解除）。
              loggedOutRef.current = false;
              setJustLoggedOut(false);
              resetButton();
              router.replace("/login");
            }}
          >
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

  // ── ログイン済み: ホーム（or ?next）へ送る間は何も描かない（13 ナビハブは廃止）。 ──
  if (loggedIn) return null;

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
