"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  exchangeIdToken as apiExchangeIdToken,
  fetchAuthNonce,
  fetchSessionMe,
  revokeSession,
  setAuthNonce,
} from "./api";
import { isDriveConfigured } from "./googleDrive";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const GSI_SRC = "https://accounts.google.com/gsi/client?hl=ja";

export const LOGOUT_CHANNEL = "sanba.auth.logout.v1";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export interface GoogleAuth {
  profile: GoogleProfile | null;
  loggedIn: boolean;
  ready: boolean;
  devMode: boolean;
  credential: string | null;
  buttonRef: React.RefObject<HTMLDivElement | null>;
  devSignIn: () => Promise<void>;
  signOut: (opts?: { broadcast?: boolean }) => Promise<void>;
  resetButton: () => void;
  driveGranted: boolean | null;
  requestDriveAccess: () => Promise<string | null>;
  refreshProfile: () => Promise<void>;
}

interface CredentialResponse {
  credential?: string;
  select_by?: string;
}

interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (res: CredentialResponse) => void;
    auto_select?: boolean;
    nonce?: string;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(): void;
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

export function useGoogleAuth(): GoogleAuth {
  const devMode = CLIENT_ID === "" && process.env.NODE_ENV !== "production";
  const [profile, setProfile] = useState<GoogleProfile | null>(null);
  const [ready, setReady] = useState(false);
  const [renderCount, setRenderCount] = useState(0);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const logoutChannelRef = useRef<BroadcastChannel | null>(null);
  const suppressAutoSelectRef = useRef(false);
  const pendingNonceRawRef = useRef<string | null>(null);
  const pendingNonceEnvelopeRef = useRef<string | null>(null);

  const [driveGranted, setDriveGranted] = useState<boolean | null>(null);
  const driveTokenRef = useRef<string | null>(null);
  const driveExpiryRef = useRef(0);

  const refreshProfile = useCallback(async (): Promise<void> => {
    const me = await fetchSessionMe();
    setProfile(me);
    setReady(true);
  }, []);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const requestDriveAccess = useCallback((): Promise<string | null> => {
    if (devMode) return Promise.resolve(null);
    if (driveTokenRef.current && Date.now() < driveExpiryRef.current - 60_000) {
      return Promise.resolve(driveTokenRef.current);
    }
    const oauth2 = window.google?.accounts.oauth2;
    if (!oauth2) return Promise.resolve(null);
    return new Promise((resolve) => {
      const settle = (token: string | null): void => {
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

  const onGoogleCredential = useCallback(async (res: CredentialResponse): Promise<void> => {
    if (!res.credential) return;
    suppressAutoSelectRef.current = false;
    const envelope = pendingNonceEnvelopeRef.current;
    const me = await apiExchangeIdToken(res.credential, envelope);
    setAuthNonce(null);
    pendingNonceEnvelopeRef.current = null;
    pendingNonceRawRef.current = null;
    if (me) {
      setProfile(me);
      setReady(true);
      if (isDriveConfigured() && res.select_by && res.select_by !== "auto") {
        void requestDriveAccess();
      }
    }
  }, [requestDriveAccess]);

  const ensureNonce = useCallback(async (): Promise<string | null> => {
    if (pendingNonceRawRef.current) return pendingNonceRawRef.current;
    const n = await fetchAuthNonce();
    if (!n) return null;
    pendingNonceRawRef.current = n.nonce;
    pendingNonceEnvelopeRef.current = n.token;
    setAuthNonce(n.token);
    return n.nonce;
  }, []);

  useEffect(() => {
    if (devMode) return;
    if (typeof window === "undefined") return;

    let cancelled = false;

    const setup = (id: GoogleIdentity, nonce: string | null): void => {
      if (cancelled) return;
      id.initialize({
        client_id: CLIENT_ID,
        callback: (res) => {
          void onGoogleCredential(res);
        },
        auto_select: !suppressAutoSelectRef.current,
        nonce: nonce ?? undefined,
      });
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
    };

    const withNonceAndSetup = async (id: GoogleIdentity): Promise<void> => {
      const nonce = await ensureNonce();
      if (!cancelled) setup(id, nonce);
    };

    const idNow = window.google?.accounts.id;
    if (idNow) {
      void withNonceAndSetup(idNow);
      return () => {
        cancelled = true;
      };
    }

    let script = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    const onLoad = (): void => {
      const id = window.google?.accounts.id;
      if (id) void withNonceAndSetup(id);
    };
    script.addEventListener("load", onLoad);
    return () => {
      cancelled = true;
      script?.removeEventListener("load", onLoad);
    };
  }, [devMode, onGoogleCredential, renderCount, ensureNonce]);

  const resetButton = useCallback(() => setRenderCount((c) => c + 1), []);

  const devSignIn = useCallback(async (): Promise<void> => {
    const me = await apiExchangeIdToken("dev-bypass", null);
    if (me) {
      setProfile(me);
      setReady(true);
    }
  }, []);

  const localReset = useCallback((): void => {
    setProfile(null);
    driveTokenRef.current = null;
    driveExpiryRef.current = 0;
    setDriveGranted(null);
    suppressAutoSelectRef.current = true;
    setAuthNonce(null);
    pendingNonceEnvelopeRef.current = null;
    pendingNonceRawRef.current = null;
    if (!devMode) window.google?.accounts.id.disableAutoSelect();
  }, [devMode]);

  const signOut = useCallback(
    async (opts?: { broadcast?: boolean }): Promise<void> => {
      await revokeSession();
      localReset();
      setReady(true);
      setRenderCount((c) => c + 1);
      if (opts?.broadcast ?? true) logoutChannelRef.current?.postMessage("logout");
    },
    [localReset],
  );

  useEffect(() => {
    if (devMode || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(LOGOUT_CHANNEL);
    channel.onmessage = () => {
      console.info("[auth] cross-tab logout received");
      localReset();
      setReady(true);
    };
    logoutChannelRef.current = channel;
    return () => {
      logoutChannelRef.current = null;
      channel.close();
    };
  }, [devMode, localReset]);

  return {
    profile,
    loggedIn: profile !== null,
    ready,
    devMode,
    credential: null,
    buttonRef,
    devSignIn,
    signOut,
    resetButton,
    driveGranted,
    requestDriveAccess,
    refreshProfile,
  };
}

const AuthContext = createContext<GoogleAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
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

export function useAuthOptional(): GoogleAuth | null {
  return useContext(AuthContext);
}
