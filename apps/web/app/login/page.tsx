"use client";

// ログイン画面（ADR-0052 / NASHI GEN 準拠のクリーン化）。
// 中央 1 カラムの最小構成: SANBA マーク → ワードマーク → タグライン → Google ボタン 1 つ。
// メール/パスワード欄・サインアップ導線・2 ペイン・上部ヘッダーは持たない。
//
// フロー（NASHI GEN と同じ）:
//   - 未ログイン → Google ボタン（GIS 純正・白系 outline / auth.tsx が描画）。押下→Google→復元で
//     credential 到着 → そのままホーム（or ?next）へ即 replace（本人確認の中間画面は挟まない）。
//   - ログイン済みで /login に来たら即ホームへ replace（ログイン画面を見せない）。
//   - 認証解決前（ready=false / GIS の静かな再取得中）はサインイン UI を出さず、中立の
//     ブランドスプラッシュ（BrandSplash）を見せる。ログイン済みの利用者に「ログインし直して
//     いる」と映る「確認中」表示は廃止した（ADR-0052。ID トークンは永続化しない ADR-0014 §7 の
//     方針は不変で、変えたのは復元中の見せ方だけ）。
//   - ログアウトはアカウントメニューから ?loggedOut=1 で来て、この画面が実際に signOut し、
//     そのままクリーンなログイン画面を見せる（挨拶画面は廃止）。
//
// 認証ロジック・認可（管理者判定は API 側 ADMIN_EMAILS）・信頼境界（ADR-0012）・nonce/リフレッシュ
// （ADR-0047）は変えない。意匠とフローのみ（CLAUDE.md「スキン」方針）。

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { BrandMark, BrandSplash, Button, Screen } from "@/components/sanba";
import { useAuth } from "@/lib/auth";

// `?next=` はユーザー操作で渡る値なので、同一オリジンの相対パスだけを許可する
// （オープンリダイレクト／`javascript:` スキーム XSS の防止）。
// 許可: "/" 始まりで "//"・"/\" でないパス。それ以外は null（既定ルートに留める）。
export function safeNextPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

export default function LoginPage() {
  const { loggedIn, ready, devMode, buttonRef, devSignIn, signOut, resetButton } = useAuth();

  const router = useRouter();
  // router を ref に退避し、遷移 effect の依存から外す（useRouter は再描画ごとに別インスタンスを
  // 返し得るため、依存に入れると遷移 effect が不必要に再実行される）。
  const routerRef = useRef(router);
  routerRef.current = router;

  // ログアウト遷移（?loggedOut=1）はマウント初回レンダーで同期確定させる。state の反映前に
  // 遷移 effect が走ってホームへ送ってしまうレースを防ぐため、遷移 effect でも参照する。
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
    // authGate の誤リダイレクトと競合しない。明示ログアウトなので他タブへも伝播する
    // （既定 broadcast:true / 要件⑤ / ADR-0030）。
    if (loggedOutRef.current) signOut();
  }, [signOut]);

  // ログイン後はホーム（or ?next）へ即送る（本人確認の中間画面は廃止 / ADR-0052）。
  // ログアウト遷移中（loggedOutRef）は送らない: signOut 適用で未ログインになったらガードを解き、
  // 以後の再サインインは通常どおりホームへ送る。マウント時点で既にログイン済み（auto_select の
  // 静かな復元）でもそのまま送る。
  useEffect(() => {
    if (loggedOutRef.current) {
      if (!loggedIn) loggedOutRef.current = false;
      return;
    }
    if (loggedIn) routerRef.current.replace(nextRef.current ?? "/");
  }, [loggedIn]);

  // 解決済みで未ログイン＝サインイン UI を見せる局面。ここで GIS 純正ボタンを buttonRef へ
  // 描き直させる（解決前は BrandSplash で buttonRef が未装着のため renderButton がスキップ
  // されている。ボタンの装着後に再描画を促す）。dev モードは純正ボタンを描かない。
  const showSignIn = ready && !loggedIn;
  useEffect(() => {
    if (showSignIn && !devMode) resetButton();
  }, [showSignIn, devMode, resetButton]);

  // 認証解決前・ログイン済み（ホームへ replace 中／ログアウト適用待ち）は中立スプラッシュ。
  // 「ログイン画面が一瞬見える」窓を作らない（ADR-0052）。
  if (!ready || loggedIn) return <BrandSplash />;

  // ── 未認証: サインイン（Google のみ＝メール/パスワード欄は持たない）──────────────
  return (
    <Screen className="items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-xs flex-col items-center gap-9 text-center">
        <div className="flex flex-col items-center gap-4">
          {/* SANBA マーク（大）。隣の見出しがブランド名を担うため装飾扱い。 */}
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
            // GIS がこの div に純正のサインインボタン（白系 outline）を描画する。金彩フレームは
            // 廃止し、白い紙面（ADR-0025）に馴染む承認バリアントをそのまま中央に置く（ADR-0052）。
            <div ref={buttonRef} className="flex min-h-[44px] w-full justify-center" />
          )}
          <p className="text-[11px] leading-relaxed text-sanba-muted">
            {devMode
              ? "※ 開発モード（GOOGLE_CLIENT_ID 未設定）。API の AUTH_DEV_BYPASS で通します。"
              : "Google アカウントで本人確認します。メールアドレスとパスワードの入力は不要です。"}
          </p>
        </div>
      </div>
    </Screen>
  );
}
