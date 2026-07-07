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

// ID トークン(約1h)の失効を先読みして能動リフレッシュするための猶予（ADR-0047 §1）。exp の
// この時間前に静かな再取得を試みる。GIS は既定ではリロード時にしか再取得しないため、これが
// 無いと長い会話の途中でトークンが切れ、LiveKit 再 join や create/join が 401 で刺さる。
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// リフレッシュ遅延の下限。クロックずれ（クライアント時計が exp より進んでいる等）で遅延が
// 過小/負になっても、この間隔より速くは再取得しない。30 秒だと歪んだ時計で「30 秒ごとに
// 静かな prompt + nonce 取得」のループになり FedCM のクールダウンを誘発するため 5 分に取る
//（正常系では exp-5min の一発だけで、この下限には当たらない）。
const MIN_REFRESH_DELAY_MS = 5 * 60 * 1000;
// nonce エンベロープの残り寿命がこれを下回ったら採り直す（ADR-0047 §2）。ID トークンの
// リフレッシュ（exp-5min）時点で必ず新しい nonce を掴み直せるよう、REFRESH_SKEW_MS より
// 大きく取る（エンベロープ TTL 65min - トークン寿命 60min = 5min の余白では足りない）。
const NONCE_REFETCH_MARGIN_MS = 10 * 60 * 1000;

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

// Google ドライブ取り込み（ADR-0049）で求める最小スコープ。drive.file は「ユーザーが
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
    // サーバ発行のログイン nonce（ADR-0047）。ID トークンの `nonce` claim に埋め込まれる。
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

/** ID トークン (JWT) の payload をデコードする。署名検証はしない（表示・時刻・照合ヒント用）。 */
function decodeClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(decodeBase64UrlUtf8(token.split(".")[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** ID トークン (JWT) の payload を表示用にデコードする。署名検証はしない。 */
export function decodeProfile(token: string): GoogleProfile | null {
  const claims = decodeClaims(token);
  if (claims === null) return null;
  return {
    email: String(claims.email ?? ""),
    name: String(claims.name ?? claims.email ?? ""),
    picture: claims.picture ? String(claims.picture) : undefined,
  };
}

/** ID トークン (JWT) の `exp`（失効時刻）をミリ秒で返す。取れなければ null（ADR-0047 §1）。 */
export function decodeExpiryMs(token: string): number | null {
  const exp = decodeClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

/** ID トークン (JWT) の `nonce` claim を返す。無ければ null（ADR-0047 §2 のペアリング用）。 */
function decodeNonceClaim(token: string): string | null {
  const nonce = decodeClaims(token)?.nonce;
  return typeof nonce === "string" && nonce !== "" ? nonce : null;
}

/** サーバ発行のログイン nonce（ADR-0047 §2）。raw は GIS へ、token は X-Auth-Nonce へ。 */
interface PendingNonce {
  raw: string;
  token: string;
  /** エンベロープの失効時刻（ミリ秒）。期限切れは GIS 初期化にもヘッダにも使わない。 */
  expiresAt: number;
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

  // ── ログイン nonce（ADR-0047 §2）─────────────────────────────────────────
  // 発行済み nonce の手持ち（メモリのみ / ADR-0014 §7）。X-Auth-Nonce ヘッダ（api.ts）の
  // 有効化は「この raw と一致する nonce claim を持つ credential が到着したとき」だけ
  // （onCredential のペアリング）。credential とエンベロープを別々に差し替えると、
  // その間のリクエストが自作の不一致 401 になるため、対でしか動かさない。
  const pendingNonceRef = useRef<PendingNonce | null>(null);
  // ペアリング不成立時の静かな採り直しは credential 1 世代につき 1 回だけ試す
  // （不成立→prompt→また不成立、の無限ループを構造的に断つ）。
  const upgradeAttemptedRef = useRef(false);
  // onCredential（deps [] で固定）からペアリング不成立時の採り直しを呼ぶためのミラー。
  // upgradeNonce は initializeGis → onCredential に依存するため、直接参照すると循環する。
  const upgradeNonceRef = useRef<() => Promise<void>>(async () => {});

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
      // ペアリング（ADR-0047 §2）: credential の nonce claim が手持ちの nonce と一致し、
      // エンベロープが未失効のときだけ X-Auth-Nonce を有効化する。不一致・欠落・期限切れは
      // ヘッダを送らない（「送って不一致 401」より「送らず missing 401」の方が正直で、
      // REQUIRE_LOGIN_NONCE=off のサーバでは何も起きない）。不成立時は nonce を採り直して
      // 静かな再取得を 1 回だけ試み、成功すれば claim 付き credential でここへ戻ってくる。
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
      // 要件: Google ログインのタイミングで Drive 権限も求める。ただし
      // - "auto"（リロード時の静かな復元）はユーザー操作が無くポップアップがブロックされる
      //   ため出さない（Drive 取り込みの操作時に requestDriveAccess が改めて同意を求める）。
      // - Drive 連携が未構成（Picker API キー未設定）の環境では導線ごと使えないため、
      //   不要な権限ポップアップを出さない（最小権限・未設定環境の退化を崩さない）。
      // 拒否されても driveGranted=false になるだけでログイン自体は成立する。
      if (isDriveConfigured() && res.select_by && res.select_by !== "auto") {
        void requestDriveAccessRef.current();
      }
    }
  }, []);

  // GIS 初期化の単一定義（初回・nonce 適用・リフレッシュのすべてが同じ設定で initialize する。
  // 分岐ごとに複製すると設定が食い違い「初回とリフレッシュ後で挙動が違う」バグの温床になる）。
  const initializeGis = useCallback(
    (id: GoogleIdentity, nonce?: string) => {
      id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true, nonce });
    },
    [onCredential],
  );

  // 手持ちの nonce を返す。残り寿命が薄い/無いときだけ採り直す（ADR-0047 §2）。取得失敗時は
  // 手持ちを返す（期限が近くても無いよりまし）。手持ちも無ければ null = nonce 無し運転
  //（ログイン UI は動き、REQUIRE_LOGIN_NONCE=on のサーバでは束縛エンドポイントが 401 を
  // 返して再サインインへ誘導される＝セキュリティ側にフェイル）。fetchAuthNonce は内部で
  // 例外を握って null を返すため、この関数は reject しない。
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

  // ペアリング不成立時の静かな採り直し（ADR-0047 §2）。fresh な nonce で initialize し直し、
  // auto_select の無表示 prompt で claim 付き credential を再発行させる。ログアウト済み・
  // nonce 取得不能なら何もしない（prompt を無駄撃ちして FedCM のクールダウンを進めない）。
  const upgradeNonce = useCallback(async () => {
    const n = await ensureNonce();
    // await 中に環境ごと畳まれることがある（テストの teardown / ページ遷移中）。window を
    // 触る前に生存確認して未処理 rejection にしない。
    if (typeof window === "undefined") return;
    const id = window.google?.accounts.id;
    if (!n || !id || credentialRef.current === null) return;
    initializeGis(id, n.raw);
    id.prompt();
  }, [ensureNonce, initializeGis]);
  upgradeNonceRef.current = upgradeNonce;

  // 失効前の静かな再取得（ADR-0047 §1）。nonce を確保して initialize し直し、One Tap を
  // 無表示で促す。Google セッションが生きていれば新トークンが onCredential に届き、ペアリングと
  // 次のリフレッシュ予約（credential キーの effect）がそこで走る。取れなければ失効後の
  // API 401 → 再サインイン導線に委ねる（従来動作。ここで強制ログアウトはしない）。
  // 有効化済みの X-Auth-Nonce にはここでは触らない: 新旧の入れ替えは onCredential の
  // ペアリングだけが行う（途中で差し替えると成功するまでの間が全部不一致 401 になる）。
  const refreshCredential = useCallback(async () => {
    if (credentialRef.current === null) return;
    const n = await ensureNonce();
    if (typeof window === "undefined") return;
    const id = window.google?.accounts.id;
    // await 中のログアウト（明示 signOut / 別タブ伝播）を中断する: ここで prompt すると
    // ログアウト直後に One Tap が再表示され、意図に反して再ログインさせてしまう。
    if (!id || credentialRef.current === null) return;
    initializeGis(id, n?.raw);
    id.prompt();
  }, [ensureNonce, initializeGis]);

  // 失効の REFRESH_SKEW_MS 前に能動リフレッシュを予約する（ADR-0047 §1）。credential が
  // 変わるたびに貼り直し、cleanup（ログアウトで null 化・アンマウント・次の credential）が
  // 必ずタイマーを解除する — 解除漏れの経路が構造的に無い。
  useEffect(() => {
    if (devMode || credential === null) return;
    const expMs = decodeExpiryMs(credential);
    if (expMs === null) return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, expMs - Date.now() - REFRESH_SKEW_MS);
    const timer = window.setTimeout(() => void refreshCredential(), delay);
    return () => window.clearTimeout(timer);
  }, [credential, devMode, refreshCredential]);

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
    // ログイン nonce（ADR-0047 §2）はスクリプトロードと並列で先読みする。initialize は
    // 1 回・nonce 付きで行い、One Tap の prompt も 1 回だけにする（nonce 無しで initialize →
    // 復元 → nonce 付きで再 initialize → 再 prompt、という二段構えはリロードのたびに
    // One Tap を 2 周させ、FedCM のクールダウンで静かな復元自体を壊す）。
    const noncePromise = ensureNonce();

    function setup(id: GoogleIdentity, nonce: string | undefined) {
      if (cancelled) return;
      // auto_select: リロード時に直前の単一アカウントを One Tap で静かに再取得する (ADR-0014 §7)。
      // ID トークンは localStorage に保存しない (XSS リスク回避)。再取得できなければ
      // 明示ログイン (ボタン) に委ねる。
      // buttonRef の有無に関わらず initialize/prompt を呼ぶ: /login でログイン後に /
      // へ戻った際、Home は buttonRef を描画しないが One Tap の auto_select で
      // 直前セッションの credential を再取得できる必要がある (ADR-0014 §7)。
      initializeGis(id, nonce);
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
      // ready かつ未ログインで誤リダイレクトする窓を作らない。
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
      // GIS が既に居る（signOut/resetButton による再実行や、テストのスタブ）: 手持ちの
      // nonce で同期に initialize/prompt する（初回マウントの nonce fetch を待たせて
      // 復元・ボタン描画を遅らせない）。手持ちが無いまま復元された credential は claim を
      // 持たないが、onCredential のペアリングが不成立を検知して 1 回だけ採り直す。
      setup(idNow, pendingNonceRef.current?.raw);
      return cleanup;
    }
    // GIS スクリプトを一度だけ読み込む。ロード完了時には並列の nonce fetch も済んでいるのが
    // 普通なので、フルロード（リロード復元の主経路）は nonce 付きの一発 initialize になる。
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
    // X-Auth-Nonce を破棄する（ADR-0047 §2）。能動リフレッシュのタイマーは credential が
    // null になった時点で予約 effect の cleanup が解除する（ここで個別に止める口を持たない）。
    // 再有効化は onCredential のペアリングだけが行うため、ログアウト状態で nonce が
    // 復活する経路は無い。upgrade の単発ガードは次のログインのために倒し直す。
    setAuthNonce(null);
    upgradeAttemptedRef.current = false;
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
