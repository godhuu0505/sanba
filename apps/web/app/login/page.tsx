"use client";

// ログイン／ログアウト ユースケース (ADR-0014 §1 / ADR-0019 金彩フレーム)。
// 2 ペイン構成（2026-07 整理）: 左 1/3 はブランドペイン（SANBA の世界観＋サインアップ導線）、
// 右メインはサインイン（Google のみ。メール/パスワードのフォームは持たない）。モバイルでは
// 縦積み（ブランド帯 → サインイン）になる。12/14 も左ペインは共通のまま、右メインの中身だけ
// が入れ替わる。
//
// サインアップについて: SANBA に専用の登録フォームは無く、Google での初回サインインが登録を
// 兼ねる（API は ID トークンを検証するだけ / ADR-0012）。左ペインの「今すぐサインアップ」は
// 右のサインイン枠へスクロールで誘導し、枠を一拍ハイライトして視線を渡す。
//
// 状態の一本道は不変: 11 未認証 → 12 サインイン中 →（ログイン後はホーム / へ誘導）。
// ログアウト完了の挨拶（14）は、ホームのアカウントメニュー（#217）から ?loggedOut=1 で来た時に出す。
//
// ログイン済みで /login に来た場合はトップ（or ?next）へ即 replace する。認証解決前
// （ready=false / GIS の静かな再取得中）はサインイン UI を出さず「確認中」を出す（authGate と
// 同じ扱い）。復元がサインイン UI（11）を経ていなければ 12 の welcome も挟まない＝
// 「ログインしているのにログイン画面が見える」瞬間を作らない。
//
// 認証ロジックと認可（管理者判定は API 側の ADMIN_EMAILS が源泉）は変えず、意匠とフローのみ
// 拡張する (CLAUDE.md「スキン」方針)。SANBA デザインシステム（components/sanba/*）を再利用。
// GIS は「サインイン開始」イベントを出さないため、12 は loggedIn の false→true 立ち上がりを
// 契機に短時間だけ見せ、自動でホームへ送る。ログイン後の導線は /login 内に持たず、Figma 正本に
// 倣ってホーム＋アカウントメニューへ集約した（監査 B-1 #1/#5）。

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AppHeader, Button, Figure, Screen } from "@/components/sanba";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

// 12「本人確認中」を見せる時間。実機・dev とも同じ間で 13 へ遷移する。
const WELCOME_MS = 1000;
// サインアップ押下でサインイン枠をハイライトして見せる時間。
const SIGNUP_PULSE_MS = 1600;

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

  const [justLoggedOut, setJustLoggedOut] = useState(false);
  const [welcoming, setWelcoming] = useState(false);
  const prevLoggedIn = useRef(loggedIn);
  // サインイン UI（11）を一度でも見せたか。ログイン確立が 11 を経ていなければ「静かな再取得
  // （auto_select）か既ログインでの直訪」なので、12 の welcome を挟まず即トップへ送る
  // （要望: ログイン済みで /login に来たらトップ画面へ）。
  const showedSignInRef = useRef(false);

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
    // 明示ログアウトなので既定どおり他タブへも伝播する（要件⑤ / ADR-0030）。
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
      // 立ち上がりでもサインイン UI（11）を経ていなければ、ボタン操作ではなく auto_select の
      // 静かな復元。12 の welcome は「操作への応答」なので挟まず、そのままトップへ送る。
      if (!showedSignInRef.current) {
        go();
        return;
      }
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
  // このタブのサインイン中断であり明示ログアウトではないため、他タブへは伝播させない
  // （broadcast:false / 既にログイン済みの他タブを巻き添えにしない / ADR-0030）。
  function handleCancelSignIn() {
    setWelcoming(false);
    signOut({ broadcast: false });
  }

  // ── サインアップ誘導（左ペイン →「右のサインイン枠」）──────────────────
  // 登録フォームは無いので、右メインのサインイン枠へスクロールし一拍ハイライトする
  // （モバイル縦積みで枠が画面外のときに効く。jsdom 等 scrollIntoView 未実装環境は ?. で無視）。
  const signinBoxRef = useRef<HTMLDivElement | null>(null);
  const [signupPulse, setSignupPulse] = useState(false);
  const pulseTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    },
    [],
  );
  function handleSignup() {
    signinBoxRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setSignupPulse(true);
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setSignupPulse(false), SIGNUP_PULSE_MS);
  }

  // 解決済みで未ログイン＝サインイン UI（11）を見せる局面。表示の事実を記録しつつ、GIS 純正
  // ボタンを buttonRef へ描き直させる（マウント時の resetButton は「確認中」表示で buttonRef が
  // 未装着のため renderButton がスキップされている。11 が現れたここで再描画を促す）。
  const showSignIn = ready && !loggedIn && !justLoggedOut;
  useEffect(() => {
    if (!showSignIn) return;
    showedSignInRef.current = true;
    if (!devMode) resetButton();
  }, [showSignIn, devMode, resetButton]);

  // ── ログイン済み: ホーム（or ?next）へ送る間は何も描かない（13 ナビハブは廃止）。 ──
  if (loggedIn && !welcoming && !justLoggedOut) return null;

  // ── 右メインの中身（確認中 / 11 サインイン / 12 本人確認中 / 14 ログアウト完了）──────
  let content: ReactNode;
  if (justLoggedOut) {
    // ── 14 ログアウト完了 ──────────────────────────────────────────
    content = (
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <p className="text-[13px] tracking-[0.4em] text-sanba-gold-text">✦ またのお越しを ✦</p>
        <h1 className="text-[30px] font-bold text-sanba-gold-text">おつかれさまでした</h1>
        <p className="text-[13px] leading-relaxed text-sanba-muted">
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
    );
  } else if (loggedIn && welcoming) {
    // ── 12 サインイン中（本人確認） ────────────────────────────────
    content = (
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div
          role="status"
          aria-label="本人確認中"
          className="size-16 animate-spin rounded-full border-4 border-sanba-border border-t-sanba-gold"
        />
        <p className="text-[17px] font-bold text-sanba-cream">
          Google アカウントを確認しています
        </p>
        <p className="text-[13px] leading-relaxed text-sanba-muted">
          本人確認のため、Google のポップアップでアカウントを選択してください。
        </p>
        {/* キャンセル（Figma 75:14）。待ちを取りやめて 11 未認証へ戻す。 */}
        <Button variant="ghost" className="mt-2" onClick={handleCancelSignIn}>
          キャンセル
        </Button>
      </div>
    );
  } else if (!ready) {
    // ── 認証解決前（GIS の静かな再取得を待つ。auth 側のフォールバックで最大 ~2.5s） ──
    // ここでサインイン UI を出すと、直前までログインしていた人に「ログイン済みなのに
    // ログイン画面へ戻された」と見えるため、確認中の表示に留める（保護ページの authGate が
    // ready を待つのと同じ扱い）。復元できれば welcome を挟まず即トップへ送られる。
    content = (
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div
          role="status"
          aria-label="ログイン状態を確認中"
          className="size-16 animate-spin rounded-full border-4 border-sanba-border border-t-sanba-gold"
        />
        <p className="text-[13px] leading-relaxed text-sanba-muted">
          ログイン状態を確認しています…
        </p>
      </div>
    );
  } else {
    // ── 11 未認証（サインイン。Google のみ＝メール/パスワード欄は持たない） ──
    content = (
      <div ref={signinBoxRef} className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <h1 className="text-[24px] font-bold text-sanba-gold-text">サインイン</h1>
        <p className="text-[13px] leading-relaxed text-sanba-muted">
          Google アカウントで本人確認します。メールアドレスとパスワードの入力は不要です。
        </p>
        {devMode ? (
          <Button
            variant="gold"
            block
            onClick={devSignIn}
            className={cn(signupPulse && "ring-4 ring-sanba-gold-light")}
          >
            開発用ログイン（bypass）
          </Button>
        ) : (
          // 金彩フレーム（ADR-0019）。GIS 純正ボタンを金彩の枠で“囲む”ことで SANBA の世界観を出す。
          // 枠はボタン本体に重ねない（地色・ロゴ・文言は GIS のまま）。アプリ全体で使う「ステッカー
          // 様式」（墨枠＋オフセット影＋手描きの揺らぎ角丸／Card.tsx と同一トークン）に揃え、
          // 単なる金の薄縁ではなく他のカード・ボタンと同じ質感にする。外側 = 山吹淡の面、
          // 内側 = 白面に純正ボタンを中央配置。
          <div
            className={cn(
              "sanba-sticker-card sanba-wobble w-full max-w-90 bg-sanba-gold-pale p-3 transition-shadow",
              signupPulse && "ring-4 ring-sanba-gold-light",
            )}
          >
            <div className="flex justify-center rounded-[10px] bg-sanba-surface p-3">
              {/* GIS がこの div に純正のサインインボタンを描画する。 */}
              <div ref={buttonRef} className="flex justify-center" />
            </div>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-sanba-muted">
          {devMode
            ? "※ 開発モード（GOOGLE_CLIENT_ID 未設定）。API の AUTH_DEV_BYPASS で通します。"
            : "※ 未ログイン時は Google のサインインがこの位置に開きます。"}
        </p>
      </div>
    );
  }

  return (
    <Screen>
      {/* どの画面でも SANBA ヘッダー（2026-07 要望）。ログインでは操作を持たないブランド提示のみ。
          左ペインのロゴはヘッダーへ一本化した（同一画面での二重ブランドを避ける）。 */}
      <AppHeader />
      <div className="flex flex-1 flex-col md:flex-row">
        {/* ── 左 1/3: ブランドペイン（SANBA の世界観＋サインアップ導線）。
            淡い紙面（surface-strong）で切り分ける（ADR-0025 白い紙×原色の範囲内）。
            モバイルでは上部の帯に縦積みし、本流（サインイン）を続けて出す。 ── */}
        <aside className="flex flex-col justify-between gap-8 border-b border-sanba-border bg-sanba-surface-strong px-6 py-8 md:w-1/3 md:border-b-0 md:border-r md:px-8 md:py-10">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="sanba-display text-[22px] font-bold leading-snug text-sanba-cream">
                問答の間へ、ようこそ
              </p>
              <p className="text-[13px] leading-relaxed text-sanba-muted">
                解像度高く、要件を生み出す音声マルチエージェント。一問ずつ問いかけ、抜けと矛盾をその場で取り上げます。
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-[12px] font-bold text-sanba-muted">
                SANBA アカウントをお持ちでない場合
              </p>
              <Button variant="outline" block onClick={handleSignup}>
                今すぐサインアップ
              </Button>
              <p className="text-[11px] leading-relaxed text-sanba-muted">
                サインアップも Google アカウントで行えます（初回サインインで自動的に登録されます）。
              </p>
            </div>
          </div>
          {/* サンバさん（歩行）。1 画面 1 体（ADR-0025）。モバイルの帯では畳む。 */}
          <Figure state="walking" className="hidden w-11 md:block" />
        </aside>

        {/* ── 右メイン: 状態で中身が入れ替わる（11 / 12 / 14）。 ── */}
        <main className="flex flex-1 flex-col items-center justify-center px-6 py-10">
          {content}
        </main>
      </div>
    </Screen>
  );
}
