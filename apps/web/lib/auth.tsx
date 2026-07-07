"use client";


import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { fetchAuthNonce, setAuthNonce } from "./api";
import { isDriveConfigured } from "./googleDrive";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const GSI_SRC = "https://accounts.google.com/gsi/client?hl=ja";

export const LOGOUT_CHANNEL = "sanba.auth.logout.v1";

export const AUTH_HINT_KEY = "sanba.auth.hint.v1";

const SETTLE_NO_HINT_MS = 2500;
const SETTLE_WITH_HINT_MS = 8000;

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 5 * 60 * 1000;
const NONCE_REFETCH_MARGIN_MS = 10 * 60 * 1000;

function readAuthHint(): boolean {
  try {
    return window.localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAuthHint(present: boolean): void {
  try {
    if (present) window.localStorage.setItem(AUTH_HINT_KEY, "1");
    else window.localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
  }
}

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
}

interface CredentialResponse {
  credential?: string;
  select_by?: string;
}

interface PromptMomentNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}

interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (res: CredentialResponse) => void;
    auto_select?: boolean;
    nonce?: string;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(momentListener?: (notification: PromptMomentNotification) => void): void;
  disableAutoSelect(): void;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (res: TokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }): TokenClient;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity; oauth2?: GoogleOAuth2 } };
  }
}

export interface GoogleAuth {
  credential: string | null;
  profile: GoogleProfile | null;
  loggedIn: boolean;
  ready: boolean;
  devMode: boolean;
  buttonRef: React.RefObject<HTMLDivElement | null>;
  devSignIn: () => void;
  signOut: (opts?: { broadcast?: boolean }) => void;
  resetButton: () => void;
  driveGranted: boolean | null;
  requestDriveAccess: () => Promise<string | null>;
}

function decodeBase64UrlUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(decodeBase64UrlUtf8(token.split(".")[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decodeProfile(token: string): GoogleProfile | null {
  const claims = decodeClaims(token);
  if (claims === null) return null;
  return {
    email: String(claims.email ?? ""),
    name: String(claims.name ?? claims.email ?? ""),
    picture: claims.picture ? String(claims.picture) : undefined,
  };
}

export function decodeExpiryMs(token: string): number | null {
  const exp = decodeClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

function decodeNonceClaim(token: string): string | null {
  const nonce = decodeClaims(token)?.nonce;
  return typeof nonce === "string" && nonce !== "" ? nonce : null;
}

interface PendingNonce {
  raw: string;
  token: string;
  expiresAt: number;
}

export function useGoogleAuth(): GoogleAuth {
  const devMode = CLIENT_ID === "";
  const [credential, setCredential] = useState<string | null>(null);
  const [devLoggedIn, setDevLoggedIn] = useState(false);
  const [renderCount, setRenderCount] = useState(0);
  const [gisSettled, setGisSettled] = useState(false);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const logoutChannelRef = useRef<BroadcastChannel | null>(null);
  const credentialRef = useRef<string | null>(null);
  credentialRef.current = credential;

  const pendingNonceRef = useRef<PendingNonce | null>(null);
  const upgradeAttemptedRef = useRef(false);
  const upgradeNonceRef = useRef<() => Promise<void>>(async () => {});

  const suppressAutoSelectRef = useRef(false);

  const [driveGranted, setDriveGranted] = useState<boolean | null>(null);
  const driveTokenRef = useRef<string | null>(null);
  const driveExpiryRef = useRef(0);

  const requestDriveAccess = useCallback((): Promise<string | null> => {
    if (devMode) return Promise.resolve(null);
    if (driveTokenRef.current && Date.now() < driveExpiryRef.current - 60_000) {
      return Promise.resolve(driveTokenRef.current);
    }
    const oauth2 = window.google?.accounts.oauth2;
    if (!oauth2) return Promise.resolve(null);
    return new Promise((resolve) => {
      const settle = (token: string | null) => {
        setDriveGranted(token !== null);
        resolve(token);
      };
      try {
        const client = oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (res) => {
            if (res.access_token && (res.scope ?? "").includes(DRIVE_SCOPE)) {
              driveTokenRef.current = res.access_token;
              driveExpiryRef.current = Date.now() + (res.expires_in ?? 3600) * 1000;
              settle(res.access_token);
            } else {
              settle(null);
            }
          },
          error_callback: (err) => {
            console.info("[auth] drive consent unavailable", { type: err?.type });
            settle(null);
          },
        });
        client.requestAccessToken();
      } catch (e) {
        console.info("[auth] drive token client failed", e);
        settle(null);
      }
    });
  }, [devMode]);

  const requestDriveAccessRef = useRef(requestDriveAccess);
  requestDriveAccessRef.current = requestDriveAccess;

  const onCredential = useCallback((res: CredentialResponse) => {
    if (res.credential) {
      suppressAutoSelectRef.current = false;
      setCredential(res.credential);
      writeAuthHint(true);
      const pending = pendingNonceRef.current;
      const claim = decodeNonceClaim(res.credential);
      if (pending && claim === pending.raw && Date.now() < pending.expiresAt) {
        setAuthNonce(pending.token);
        upgradeAttemptedRef.current = false;
      } else {
        setAuthNonce(null);
        if (!upgradeAttemptedRef.current) {
          upgradeAttemptedRef.current = true;
          void upgradeNonceRef.current();
        }
      }
      if (isDriveConfigured() && res.select_by && res.select_by !== "auto") {
        void requestDriveAccessRef.current();
      }
    }
  }, []);

  const initializeGis = useCallback(
    (id: GoogleIdentity, nonce?: string) => {
      id.initialize({
        client_id: CLIENT_ID,
        callback: onCredential,
        auto_select: !suppressAutoSelectRef.current,
        nonce,
      });
    },
    [onCredential],
  );

  const ensureNonce = useCallback(async (): Promise<PendingNonce | null> => {
    const cached = pendingNonceRef.current;
    if (cached && cached.expiresAt - Date.now() > NONCE_REFETCH_MARGIN_MS) return cached;
    const n = await fetchAuthNonce();
    if (n) {
      const fresh: PendingNonce = { raw: n.nonce, token: n.token, expiresAt: n.expires_at * 1000 };
      pendingNonceRef.current = fresh;
      return fresh;
    }
    return cached;
  }, []);

  const upgradeNonce = useCallback(async () => {
    const n = await ensureNonce();
    if (typeof window === "undefined") return;
    const id = window.google?.accounts.id;
    if (!n || !id || credentialRef.current === null) return;
    initializeGis(id, n.raw);
    id.prompt();
  }, [ensureNonce, initializeGis]);
  upgradeNonceRef.current = upgradeNonce;

  const refreshCredential = useCallback(async () => {
    if (credentialRef.current === null) return;
    const n = await ensureNonce();
    if (typeof window === "undefined") return;
    const id = window.google?.accounts.id;
    if (!id || credentialRef.current === null) return;
    initializeGis(id, n?.raw);
    id.prompt();
  }, [ensureNonce, initializeGis]);

  useEffect(() => {
    if (devMode || credential === null) return;
    const expMs = decodeExpiryMs(credential);
    if (expMs === null) return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, expMs - Date.now() - REFRESH_SKEW_MS);
    const timer = window.setTimeout(() => void refreshCredential(), delay);
    return () => window.clearTimeout(timer);
  }, [credential, devMode, refreshCredential]);

  useEffect(() => {
    if (devMode) return;

    let cancelled = false;
    const hadSession = readAuthHint();
    const settleTimer = window.setTimeout(() => {
      if (cancelled) return;
      if (hadSession && credentialRef.current === null) {
        console.info("[auth] silent restore timed out; clearing auth hint");
        writeAuthHint(false);
      }
      setGisSettled(true);
    }, hadSession ? SETTLE_WITH_HINT_MS : SETTLE_NO_HINT_MS);
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
    };
    const noncePromise = ensureNonce();

    function setup(id: GoogleIdentity, nonce: string | undefined) {
      if (cancelled) return;
      initializeGis(id, nonce);
      if (suppressAutoSelectRef.current) id.disableAutoSelect();
      if (buttonRef.current) {
        id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          locale: "ja",
        });
      }
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

    const idNow = window.google?.accounts.id;
    if (idNow) {
      setup(idNow, pendingNonceRef.current?.raw);
      return cleanup;
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const onLoad = () => {
      void noncePromise.then((n) => {
        const id = window.google?.accounts.id;
        if (!id || cancelled) return;
        setup(id, n?.raw);
      });
    };
    script.addEventListener("load", onLoad);
    return () => {
      cleanup();
      script?.removeEventListener("load", onLoad);
    };
  }, [devMode, onCredential, renderCount, ensureNonce, initializeGis]);

  const resetButton = useCallback(() => setRenderCount((c) => c + 1), []);
  const devSignIn = useCallback(() => setDevLoggedIn(true), []);

  const resetLocalAuth = useCallback(() => {
    setCredential(null);
    setDevLoggedIn(false);
    driveTokenRef.current = null;
    driveExpiryRef.current = 0;
    setDriveGranted(null);
    writeAuthHint(false);
    setAuthNonce(null);
    upgradeAttemptedRef.current = false;
    suppressAutoSelectRef.current = true;
    if (!devMode) window.google?.accounts.id.disableAutoSelect();
  }, [devMode]);

  const signOut = useCallback(
    (opts?: { broadcast?: boolean }) => {
      resetLocalAuth();
      setRenderCount((c) => c + 1);
      if (opts?.broadcast ?? true) logoutChannelRef.current?.postMessage("logout");
    },
    [resetLocalAuth],
  );

  useEffect(() => {
    if (devMode || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(LOGOUT_CHANNEL);
    channel.onmessage = () => {
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
    driveGranted,
    requestDriveAccess,
  };
}

const AuthContext = createContext<GoogleAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useGoogleAuth();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuth(): GoogleAuth {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth は <AuthProvider> の内側で呼び出してください。");
  }
  return ctx;
}
