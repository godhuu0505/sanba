"use client";

// Google ログイン (ADR-0012)。Google Identity Services (GIS) で OIDC の ID トークン
// (credential) を取得し、API 呼び出しに Bearer として渡す。検証は **サーバ (FastAPI)**
// 側で行うため、ここで得たトークンは「Google が本人に発行した主張」を運ぶだけ。
//
// NEXT_PUBLIC_GOOGLE_CLIENT_ID が未設定のローカル開発では dev モードに退避し、
// API の AUTH_DEV_BYPASS と組み合わせて `just up` の体験を壊さない。

import { useCallback, useEffect, useRef, useState } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const GSI_SRC = "https://accounts.google.com/gsi/client";

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
}

interface CredentialResponse {
  credential?: string;
}

// GIS のうち本フックが使う最小サブセットだけを宣言する。
interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (res: CredentialResponse) => void;
    auto_select?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
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
        id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
        });
      }
      // One Tap を表示して自動再取得を試みる (未ログイン時のみ意味を持つ)。
      id.prompt();
      // GIS の再取得試行をひと通り走らせた = 解決済みとみなす。auto_select で credential が
      // 届く場合は onCredential が loggedIn を true にするため、ゲートは ready かつ未ログインの
      // ときだけリダイレクトする。
      if (!cancelled) setGisSettled(true);
    }

    if (window.google?.accounts.id) {
      setup();
      return;
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
      cancelled = true;
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
