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
  signOut: () => void;
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
  const signOut = useCallback(() => {
    setCredential(null);
    setDevLoggedIn(false);
    setRenderCount((c) => c + 1);
    if (!devMode) window.google?.accounts.id.disableAutoSelect();
  }, [devMode]);

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
