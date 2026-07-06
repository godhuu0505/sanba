"use client";

// Google ログイン (ADR-0012)。Google Identity Services (GIS) で OIDC の ID トークン
// (credential) を取得し、API 呼び出しに Bearer として渡す。検証は **サーバ (FastAPI)**
// 側で行うため、ここで得たトークンは「Google が本人に発行した主張」を運ぶだけ。
//
// NEXT_PUBLIC_GOOGLE_CLIENT_ID が未設定のローカル開発では dev モードに退避し、
// API の AUTH_DEV_BYPASS と組み合わせて `just up` の体験を壊さない。

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { fetchAuthNonce, setAuthNonce } from "./api";
import { isDriveConfigured } from "./googleDrive";

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

// 「このブラウザで SANBA にログインしたことがある」ことだけを示す非機微なヒント（ADR-0014 §7 更新）。
// トークンや PII は一切含まない真偽値で、静かな再取得（auto_select）の解決をどれだけ待つかの
// 判断にだけ使う。ヒントがあるのに固定 2.5s で「未ログイン確定」にすると、GIS スクリプトの
// ロード＋One Tap 再取得がそれより遅い環境で、ログイン済みユーザーが保護ページ→/login→復元→
// 元ページ、と毎回ログイン画面を経由してしまう（issue: ログイン判定バグ）。
// ID トークン本体を localStorage に置かない方針（ADR-0014 §7 / XSS 回避）は不変。
export const AUTH_HINT_KEY = "sanba.auth.hint.v1";

// 静かな再取得（auto_select）の解決を待つフォールバック上限。GIS からの通知も credential も
// 来ない場合にこの時間で「未ログイン」として解決する。ログイン痕跡（AUTH_HINT_KEY）がある
// ブラウザでは復元成功の見込みが高いため、スクリプトロード込みでも間に合うよう延長する。
const SETTLE_NO_HINT_MS = 2500;
const SETTLE_WITH_HINT_MS = 8000;

// ID トークン(約1h)の失効を先読みして能動リフレッシュするための猶予（ADR-0046 / P1）。exp の
// この時間前に静かな再取得を試みる。GIS は既定ではリロード時にしか再取得しないため、これが
// 無いと長い会話の途中でトークンが切れ、LiveKit 再 join や create/join が 401 で刺さる。
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// リフレッシュ間隔の下限。クロックずれや短命トークンで遅延が過小/負になってもタイトループに
// しないための安全弁。
const MIN_REFRESH_DELAY_MS = 30 * 1000;

/** ログイン痕跡ヒントを読む。localStorage 不可の環境（プライベートモード等）は false 扱い。 */
function readAuthHint(): boolean {
  try {
    return window.localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** ログイン痕跡ヒントを書く/消す。書けない環境では黙って諦める（挙動は従来どおりに退化）。 */
function writeAuthHint(present: boolean): void {
  try {
    if (present) window.localStorage.setItem(AUTH_HINT_KEY, "1");
    else window.localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
    // no-op
  }
}

// Google ドライブ取り込み（ADR-0044）で求める最小スコープ。drive.file は「ユーザーが
// Google Picker で選んだファイルだけ」読めるスコープで、Drive 全体は見えない（最小権限・
// Google の追加審査も不要）。アクセストークンは ID トークンと同じくメモリのみ保持
// （ADR-0014 §7: 永続化しない）。
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
}

interface CredentialResponse {
  credential?: string;
  /**
   * 取得経路（GIS 仕様）。"auto" = リロード時の静かな復元（One Tap auto_select）、
   * それ以外（btn/user 等）= ユーザーの明示的なログイン操作。Drive 同意ポップアップを
   * 出してよいか（ユーザー操作起点か）の判定に使う。
   */
  select_by?: string;
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
    // サーバ発行のログイン nonce（ADR-0046）。ID トークンの `nonce` claim に埋め込まれる。
    nonce?: string;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  prompt(momentListener?: (notification: PromptMomentNotification) => void): void;
  disableAutoSelect(): void;
}

// GIS OAuth2 トークンクライアント（Drive 取り込み用）の最小サブセット。
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  /** 実際に許可されたスコープ（空白区切り）。同意画面でチェックを外されることがある。 */
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
  /**
   * Google ドライブ（drive.file）の同意状態。null = 未確定（未要求・トークン失効後）、
   * true = 許可済み（有効なアクセストークンあり）、false = 拒否/取得失敗。
   * false のとき Drive 取り込みは動かない（UI は再同意導線を出す）。
   */
  driveGranted: boolean | null;
  /**
   * Drive アクセストークンを（再）取得する。有効なトークンが手元にあればポップアップを
   * 出さず使い回し、無ければ GIS の同意ポップアップで再度権限を求める（要件: 権限が
   * もらえていない状態でアップロードしようとしたら再度権限を求める）。取得できなければ
   * null（拒否・ポップアップブロック・dev モード）。トークンはメモリのみ保持。
   */
  requestDriveAccess: () => Promise<string | null>;
}

/**
 * base64url 文字列を UTF-8 として復号する。JWT payload は base64url でエンコードされ、
 * 日本語名などは UTF-8 マルチバイト列になっている。`atob` の戻り値は 1 文字 = 1 バイトの
 * 「バイナリ文字列」（各コードポイントが 0–255 の生バイト）でしかないため、そのまま
 * `JSON.parse` に渡すとマルチバイト列が Latin-1 の別文字として解釈され文字化けする
 * （例: `田中 五大` → `ç"°ä¸­ ç"¤§`）。生バイトを `TextDecoder` で UTF-8 復号して直す。
 * ASCII のみのメール等が化けなかったのは、ASCII 範囲では Latin-1 と UTF-8 が一致するため。
 */
function decodeBase64UrlUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** ID トークン (JWT) の payload を表示用にデコードする。署名検証はしない。 */
export function decodeProfile(token: string): GoogleProfile | null {
  try {
    const payload = token.split(".")[1];
    const json = decodeBase64UrlUtf8(payload);
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

/** ID トークン (JWT) の `exp`（失効時刻）をミリ秒で返す。取れなければ null（ADR-0046）。 */
function decodeExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(decodeBase64UrlUtf8(payload)) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
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
  // settle タイマーのコールバックから「その時点の」ログイン状態を読むためのミラー
  // （effect のクロージャは生成時の state しか見えないため）。
  const credentialRef = useRef<string | null>(null);
  credentialRef.current = credential;

  // ID トークン能動リフレッシュ（ADR-0046 / P1）。タイマーと、循環参照を避けるための
  // コールバックのミラー（onCredential → scheduleRefresh → refreshCredential → onCredential）。
  const refreshTimerRef = useRef<number | null>(null);
  const onCredentialRef = useRef<(res: CredentialResponse) => void>(() => {});
  const scheduleRefreshRef = useRef<(token: string) => void>(() => {});
  const refreshCredentialRef = useRef<() => void>(() => {});

  // ── Google ドライブ（drive.file）の同意・アクセストークン ─────────────────
  // ADR-0014 §7 の方針どおりメモリのみ（localStorage に置かない）。expiry を控え、
  // 失効後の取り込みでは requestDriveAccess が静かに再取得（同意済みなら即時）する。
  const [driveGranted, setDriveGranted] = useState<boolean | null>(null);
  const driveTokenRef = useRef<string | null>(null);
  const driveExpiryRef = useRef(0);

  const requestDriveAccess = useCallback((): Promise<string | null> => {
    // dev モード（client_id 未設定）は実 Drive を呼べないため常に不可（UI 側が案内する）。
    if (devMode) return Promise.resolve(null);
    // 失効 1 分前までのトークンは使い回す（取り込み連打で同意ポップアップを乱発しない）。
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
            // 同意画面でスコープのチェックを外して許可されることがあるため、トークンの有無
            // だけでなく drive.file が実際に許可されたかも確認する（fail-closed）。
            if (res.access_token && (res.scope ?? "").includes(DRIVE_SCOPE)) {
              driveTokenRef.current = res.access_token;
              driveExpiryRef.current = Date.now() + (res.expires_in ?? 3600) * 1000;
              settle(res.access_token);
            } else {
              settle(null);
            }
          },
          // 拒否（access_denied）・ポップアップブロックはここに届く。false に確定し、
          // 次の取り込み操作で再度同意を求める（UI は導線を出す）。
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

  // onCredential（ログイン確定）から最新の requestDriveAccess を呼ぶためのミラー。
  const requestDriveAccessRef = useRef(requestDriveAccess);
  requestDriveAccessRef.current = requestDriveAccess;

  const onCredential = useCallback((res: CredentialResponse) => {
    if (res.credential) {
      setCredential(res.credential);
      // 次回のフルロードで「復元を待つ価値がある」ことを残す（トークンは含めない）。
      writeAuthHint(true);
      // 失効前の能動リフレッシュを仕掛ける（ADR-0046 / P1）。新トークン到着のたびに貼り直す。
      scheduleRefreshRef.current(res.credential);
      // 要件: Google ログインのタイミングで Drive 権限も求める。ただし
      // - "auto"（リロード時の静かな復元）はユーザー操作が無くポップアップがブロックされる
      //   ため出さない（Drive 取り込みの操作時に requestDriveAccess が改めて同意を求める）。
      // - Drive 連携が未構成（Picker API キー未設定）の環境では導線ごと使えないため、
      //   不要な権限ポップアップを出さない（最小権限・未設定環境の退化を崩さない / Codex P2）。
      // 拒否されても driveGranted=false になるだけでログイン自体は成立する。
      if (isDriveConfigured() && res.select_by && res.select_by !== "auto") {
        void requestDriveAccessRef.current();
      }
    }
  }, []);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // 失効前の静かな再取得（ADR-0046 / P1）。nonce を採り直して initialize し直し、One Tap を
  // 無表示で促す。Google セッションが生きていれば新トークンが onCredential に届き、そこで
  // 次のリフレッシュが再スケジュールされる。取れなければ失効後の API 401 → 再サインイン導線に
  // 委ねる（現行動作。ここで強制ログアウトはしない）。
  const refreshCredential = useCallback(async () => {
    const id = window.google?.accounts.id;
    if (!id) return;
    try {
      const n = await fetchAuthNonce();
      setAuthNonce(n?.token ?? null);
      id.initialize({
        client_id: CLIENT_ID,
        callback: onCredentialRef.current,
        auto_select: true,
        nonce: n?.nonce,
      });
      id.prompt();
    } catch (e) {
      console.info("[auth] silent refresh failed", e);
    }
  }, []);

  const scheduleRefresh = useCallback(
    (token: string) => {
      clearRefreshTimer();
      if (devMode) return;
      const expMs = decodeExpiryMs(token);
      if (expMs === null) return;
      const delay = Math.max(MIN_REFRESH_DELAY_MS, expMs - Date.now() - REFRESH_SKEW_MS);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshCredentialRef.current();
      }, delay);
    },
    [clearRefreshTimer, devMode],
  );

  // 循環参照を避けるためコールバックはミラーで参照する（onCredential は deps [] で固定のため）。
  onCredentialRef.current = onCredential;
  scheduleRefreshRef.current = scheduleRefresh;
  refreshCredentialRef.current = refreshCredential;

  // アンマウント時にリフレッシュタイマーを片付ける（AuthProvider は常駐だが衛生的に）。
  useEffect(() => () => clearRefreshTimer(), [clearRefreshTimer]);

  useEffect(() => {
    if (devMode) return; // dev モードでは GIS を読み込まない。

    let cancelled = false;
    // フォールバック: スクリプトのロード失敗や通知の取りこぼしで解決できないと ready が永久に
    // false のまま保護ページが解決待ちで止まるため、一定時間で必ず解決済みにする。
    // ログイン痕跡（AUTH_HINT_KEY）があるブラウザでは auto_select の復元成功が見込めるため
    // 長めに待つ（固定 2.5s だとスクリプトロード＋再取得に間に合わず、ログイン済みなのに
    // /login へ誤送→復元後に元ページへ戻る、という不要な往復が毎回起きる）。
    // ヒントが無ければ復元は起き得ないので従来どおり短く解決する。
    const hadSession = readAuthHint();
    const settleTimer = window.setTimeout(() => {
      if (cancelled) return;
      if (hadSession && credentialRef.current === null) {
        // 待っても復元できなかった＝Google セッション切れ等。ヒントを消し、次回ロードが
        // 長待ちしないようにする（調査用の痕跡。PII なし / CLAUDE.md 原則3）。
        console.info("[auth] silent restore timed out; clearing auth hint");
        writeAuthHint(false);
      }
      setGisSettled(true);
    }, hadSession ? SETTLE_WITH_HINT_MS : SETTLE_NO_HINT_MS);
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
    };
    // ログイン nonce（ADR-0046）を採って適用する。GIS 初期化はブロックしない（同期パスで
    // initialize/prompt を先に済ませてログイン UI と復元を最速で動かす）。nonce が採れたら
    // それを載せて initialize し直し、既に credential を復元済み（reload の auto_select が
    // nonce 前に走ったケース）なら nonce 付きで採り直す。失敗（オフライン/サーバ古い）時は
    // nonce 無しのままにし、REQUIRE_LOGIN_NONCE=on サーバでは create/join が 401 になって
    // 再サインインへ誘導される＝セキュリティ側にフェイルする。
    async function applyNonce(id: GoogleIdentity) {
      const n = await fetchAuthNonce();
      if (cancelled || !n) return;
      setAuthNonce(n.token);
      id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true, nonce: n.nonce });
      if (credentialRef.current) id.prompt();
    }

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
      // nonce はバックグラウンドで採って適用する（同期の initialize/prompt はブロックしない）。
      void applyNonce(id);
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
    // Drive アクセストークンも道連れにする（ログアウト後に前ユーザーの Drive を読めない）。
    driveTokenRef.current = null;
    driveExpiryRef.current = 0;
    setDriveGranted(null);
    // ログアウト後のフルロードで復元待ち（長い settle）に入らないようヒントも消す。
    writeAuthHint(false);
    // 能動リフレッシュを止め、nonce も破棄する（ADR-0046）: ログアウト後に再取得や nonce
    // 送出が続かないようにする。
    clearRefreshTimer();
    setAuthNonce(null);
    if (!devMode) window.google?.accounts.id.disableAutoSelect();
  }, [devMode, clearRefreshTimer]);

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
    driveGranted,
    requestDriveAccess,
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
