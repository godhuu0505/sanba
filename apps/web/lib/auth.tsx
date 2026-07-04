"use client";

// Google ログイン (ADR-0012)。Google Identity Services (GIS) で OIDC の ID トークン
// (credential) を取得し、API 呼び出しに Bearer として渡す。検証は **サーバ (FastAPI)**
// 側で行うため、ここで得たトークンは「Google が本人に発行した主張」を運ぶだけ。
//
// NEXT_PUBLIC_GOOGLE_CLIENT_ID が未設定のローカル開発では dev モードに退避し、
// API の AUTH_DEV_BYPASS と組み合わせて `just up` の体験を壊さない。

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
// ボタン言語を日本語に固定する。Google 公式ガイド（display-button#button_language）は、
// 手動固定時に script URL の `?hl=` と JS の `locale` を**併用**する手順を示す。`locale:"ja"`
// だけだとユーザーのブラウザ/Google 設定に依存し「Google で続行」に揃わない場合がある (ADR-0019)。
const GSI_SRC = "https://accounts.google.com/gsi/client?hl=ja";

// 別タブでのログアウトを同一オリジンの他タブへ伝えるチャネル名（ADR-0030。要件: 別タブで
// ログアウトしたら元タブも次のアクションで /login へ）。流すのは「ログアウトした」という
// 非機微な事実のみで、トークンそのものは決して載せない（ADR-0014 §7: ID トークンは永続化
// しない＝XSS 漏えい回避、の方針は不変）。localStorage の storage イベントではなく
// BroadcastChannel を使う: 残留アーティファクトが無く、同値書き込みで発火しない癖への
// ユニーク値細工も不要になる（比較は ADR-0030）。
export const LOGOUT_CHANNEL = "sanba.auth.logout.v1";

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
}

interface CredentialResponse {
  credential?: string;
}

// One Tap の表示結果通知（本フックが使う最小サブセット）。
interface PromptMomentNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}

// GIS のうち本フックが使う最小サブセットだけを宣言する。
interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (res: CredentialResponse) => void;
    auto_select?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(momentListener?: (notification: PromptMomentNotification) => void): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

export interface GoogleAuth {
  /** 検証用に API へ渡す ID トークン。dev モード/未ログインでは null。 */
  credential: string | null;
  /** 表示用にトークンから取り出したプロフィール (装飾目的のみ)。 */
  profile: GoogleProfile | null;
  /** ログイン済みか (dev モードでは devSignIn 後に true)。 */
  loggedIn: boolean;
  /**
   * 認証解決が済んだか。dev モードは即 true、real モードは GIS の再取得(One Tap)試行が
   * 完了したら true。RequireAuth が解決前に /login へ早期リダイレクトするのを防ぐために使う。
   */
  ready: boolean;
  /** client_id 未設定のローカル開発モード。 */
  devMode: boolean;
  /** GIS ボタンを描画する div の ref (real モードのみ使用)。 */
  buttonRef: React.RefObject<HTMLDivElement | null>;
  /** dev モードのログイン (トークン無しで通す)。 */
  devSignIn: () => void;
  /**
   * ログアウト。既定（broadcast 省略/true）で他タブへも伝播する（ADR-0030）。401 期限切れ回復や
   * サインインのキャンセル等、ユーザーの明示ログアウトでない経路は { broadcast: false } で
   * 自タブに留める（他タブの進行中セッションを巻き添えにしない）。
   */
  signOut: (opts?: { broadcast?: boolean }) => void;
  /** ログアウト→再ログイン導線で GIS ボタンを再描画させる。state 14 → 11 への遷移時に呼ぶ。 */
  resetButton: () => void;
}

/** ID トークン (JWT) の payload を表示用にデコードする。署名検証はしない。 */
function decodeProfile(token: string): GoogleProfile | null {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as Record<string, unknown>;
    return {
      email: String(claims.email ?? ""),
      name: String(claims.name ?? claims.email ?? ""),
      picture: claims.picture ? String(claims.picture) : undefined,
    };
  } catch {
    return null;
  }
}

export function useGoogleAuth(): GoogleAuth {
  const devMode = CLIENT_ID === "";
  const [credential, setCredential] = useState<string | null>(null);
  const [devLoggedIn, setDevLoggedIn] = useState(false);
  const [renderCount, setRenderCount] = useState(0);
  const [gisSettled, setGisSettled] = useState(false);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  // 他タブへのログアウト伝播チャネル（ADR-0030）。購読 effect が生成し、signOut が送信に使う。
  const logoutChannelRef = useRef<BroadcastChannel | null>(null);

  const onCredential = useCallback((res: CredentialResponse) => {
    if (res.credential) setCredential(res.credential);
  }, []);

  useEffect(() => {
    if (devMode) return; // dev モードでは GIS を読み込まない。

    let cancelled = false;
    // フォールバック: スクリプトのロード失敗や通知の取りこぼしで解決できないと ready が永久に
    // false のまま保護ページが空白になるため、一定時間で必ず解決済みにする（auto_select の
    // credential はこれより速く届く想定の猶予）。
    const settleTimer = window.setTimeout(() => {
      if (!cancelled) setGisSettled(true);
    }, 2500);
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
    };
    function setup() {
      const id = window.google?.accounts.id;
      if (!id || cancelled) return;
      // auto_select: リロード時に直前の単一アカウントを One Tap で静かに再取得する (ADR-0014 §7)。
      // ID トークンは localStorage に保存しない (XSS リスク回避)。再取得できなければ
      // 明示ログイン (ボタン) に委ねる。
      // buttonRef の有無に関わらず initialize/prompt を呼ぶ: /login でログイン後に /
      // へ戻った際、Home は buttonRef を描画しないが One Tap の auto_select で
      // 直前セッションの credential を再取得できる必要がある (P1)。
      id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true });
      if (buttonRef.current) {
        // 意匠は ADR-0019: 純正ボタンは Google 承認バリアントへ寄せ（filled_black /
        // continue_with / ja）、金彩は本ボタンを囲むフレーム側（login 画面）で表現する。
        // ボタン地色・ロゴ・文言は改変しない（ブランド規約／ADR-0012 信頼境界は不変）。
        id.renderButton(buttonRef.current, {
          theme: "filled_black",
          size: "large",
          text: "continue_with",
          shape: "pill",
          locale: "ja",
        });
      }
      // One Tap を表示して自動再取得を試みる (未ログイン時のみ意味を持つ)。
      // 表示されない/スキップ/閉じられた = auto_select で credential 復元できない確定なので
      // そこで解決済みとする。credential が届く場合は onCredential が先に loggedIn を立てるため、
      // ready かつ未ログインで誤リダイレクトする窓を作らない（Codex 指摘）。
      id.prompt((notification) => {
        if (
          notification.isNotDisplayed() ||
          notification.isSkippedMoment() ||
          notification.isDismissedMoment()
        ) {
          if (!cancelled) setGisSettled(true);
        }
      });
    }

    if (window.google?.accounts.id) {
      setup();
      return cleanup;
    }
    // GIS スクリプトを一度だけ読み込む。
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", setup);
    return () => {
      cleanup();
      script?.removeEventListener("load", setup);
    };
  }, [devMode, onCredential, renderCount]);

  const resetButton = useCallback(() => setRenderCount((c) => c + 1), []);
  const devSignIn = useCallback(() => setDevLoggedIn(true), []);

  // このタブ（ローカル）の認証状態だけを落とす共通処理。明示ログアウト（signOut）と、
  // 別タブ由来のログアウト（BroadcastChannel 受信）の両方が使う。他タブへの伝播・ボタン再描画は
  // 含めない（強制ログアウト時に保護ページで One Tap を再表示させないため）。
  const resetLocalAuth = useCallback(() => {
    setCredential(null);
    setDevLoggedIn(false);
    if (!devMode) window.google?.accounts.id.disableAutoSelect();
  }, [devMode]);

  const signOut = useCallback(
    (opts?: { broadcast?: boolean }) => {
      resetLocalAuth();
      // 再ログイン導線（/login）で GIS 純正ボタンを描き直せるよう renderCount を進める（従来どおり）。
      setRenderCount((c) => c + 1);
      // 明示ログアウト（既定）のみ他タブへ伝える（ADR-0030）。401 期限切れ回復・サインイン
      // キャンセルは { broadcast: false } で自タブに留める: 会話中の API は session_token で
      // 動くため idToken 失効では止まらないのに、伝播すると他タブの進行中会話を authGate 経由で
      // 殺してしまう。自インスタンスからの postMessage は自分の onmessage に届かない
      // （BroadcastChannel 仕様）ためループしない。dev モード・BroadcastChannel 不在環境では
      // ref が null のままなので no-op（自タブのログアウトは成立する）。
      if (opts?.broadcast ?? true) logoutChannelRef.current?.postMessage("logout");
    },
    [resetLocalAuth],
  );

  // 別タブでのログアウトを検知して、このタブの認証状態も落とす（ADR-0030）。credential を落とすと
  // loggedIn=false になり、保護ページ（authGate）が次の描画で /login?next= へ送る＝「別タブで
  // ログアウトしたら元タブも次のアクションでログイン画面へ」を満たす。dev モードは AUTH_DEV_BYPASS
  // に委ねるため購読しない（他タブがローカルの devLoggedIn を落とさない）。BroadcastChannel の
  // 無い環境ではタブ間伝播だけを諦める（自タブのログアウトは成立）。
  useEffect(() => {
    if (devMode || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(LOGOUT_CHANNEL);
    channel.onmessage = () => {
      // 強制ログアウトはユーザーには「突然ログイン画面へ飛ばされた」と見えるため、調査用の
      // 痕跡を残す（CLAUDE.md 原則3。PII なし・受信の事実のみ）。
      console.info("[auth] cross-tab logout received");
      resetLocalAuth();
    };
    logoutChannelRef.current = channel;
    return () => {
      logoutChannelRef.current = null;
      channel.close();
    };
  }, [devMode, resetLocalAuth]);

  return {
    credential,
    profile: credential ? decodeProfile(credential) : null,
    loggedIn: devMode ? devLoggedIn : credential !== null,
    ready: devMode ? true : credential !== null || gisSettled,
    devMode,
    buttonRef,
    devSignIn,
    signOut,
    resetButton,
  };
}

// ── アプリ共通の認証コンテキスト ───────────────────────────────────────────
// useGoogleAuth はルートごとに独立した state を持つため、ページ単位で呼ぶと credential が
// ルート跨ぎで共有されない（ログイン直後に遷移先 Home が null から始まりログインループする等）。
// AuthProvider を layout.tsx に一度だけ置き、全ルートが useAuth() で同一インスタンスを読む。
// credential は依然 in-memory のみで localStorage には保存しない（ADR-0014 §7 の XSS 方針は不変）。
const AuthContext = createContext<GoogleAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useGoogleAuth();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

/** アプリ単一の認証状態を読む。AuthProvider の外で呼ぶと throw する。 */
export function useAuth(): GoogleAuth {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth は <AuthProvider> の内側で呼び出してください。");
  }
  return ctx;
}
