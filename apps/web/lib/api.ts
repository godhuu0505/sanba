import type { Detection, Question, Requirement } from "./realtime/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// ── ログイン nonce（ADR-0047 §2 / ID トークン注入対策）─────────────────────
// サーバ発行の nonce エンベロープ。AuthProvider が「エンベロープと一致する nonce claim を
// 持つ credential が到着したとき」だけ setAuthNonce で有効化する（credential とエンベロープは
// 常に対で動かす。片方だけ差し替えると不一致 401 を自分で作ってしまう）。nonce は「今ログイン
// しているクライアントの ambient な認証状態」で業務引数ではないため、長い createSession の
// 引数に増やさず authHeaders の単一経路で全 authorized リクエストに載せる（サーバが照合する
// のは束縛エンドポイントのみ: create/join・products/join・admin / enforce_login_nonce）。
let currentAuthNonce: string | null = null;

/** 現在のログイン nonce エンベロープを差し替える（null で消す）。AuthProvider が呼ぶ。 */
export function setAuthNonce(envelope: string | null): void {
  currentAuthNonce = envelope;
}

export interface AuthNonce {
  /** GIS の id.initialize({nonce}) に渡す生 nonce。 */
  nonce: string;
  /** X-Auth-Nonce に載せる HMAC 署名エンベロープ。 */
  token: string;
  /** エンベロープの失効時刻（UNIX 秒）。期限切れの nonce で GIS を初期化しないために使う。 */
  expires_at: number;
}

/**
 * GET /api/auth/nonce（ADR-0047）。ログイン nonce を採る。失敗時は null（呼び出し側は
 * nonce 無しで GIS を初期化する: ログイン UI は動くが、REQUIRE_LOGIN_NONCE=on の
 * サーバでは create/join が 401 になり再サインインへ誘導される＝セキュリティ側にフェイル）。
 */
export async function fetchAuthNonce(): Promise<AuthNonce | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/nonce`);
    if (!res.ok) return null;
    return (await res.json()) as AuthNonce;
  } catch {
    return null;
  }
}

// 検証済み identity を API に運ぶ (ADR-0012)。idToken が null (dev モード) のときは
// Authorization を付けず、API 側の AUTH_DEV_BYPASS に委ねる。
function authHeaders(idToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  // ログイン nonce（ADR-0047 §2）。照合は束縛エンドポイントのみだが、単一経路で載せる
  // （他エンドポイントは未知ヘッダとして無視する）。
  if (currentAuthNonce) headers["X-Auth-Nonce"] = currentAuthNonce;
  return headers;
}

export interface CreateSessionResponse {
  session_id: string;
  invites: Record<string, string>;
}

export interface JoinResponse {
  token: string;
  livekit_url: string;
  session_id: string;
  identity: string;
  // 契約 §4: ハイドレーション/起票 API（GET /requirements 等）を保護する
  // 「join 済みトークン」。Google idToken ではなくこれを Bearer に使う。
  session_token: string;
}

export async function createSession(
  roles: string[],
  consentAcknowledged: boolean,
  idToken: string | null,
  title?: string,
  githubRepo?: string,
  productId?: string,
  goal?: string,
  goalDetail?: string,
): Promise<CreateSessionResponse> {
  const body: Record<string, unknown> = { roles, consent_acknowledged: consentAcknowledged };
  // title 未指定なら API 既定 ("要件インタビュー") に委ねる。
  if (title !== undefined) body.title = title;
  // 連携リポジトリ（任意 / ADR-0027）。undefined = 未指定（API が product/既定へフォールバック）、
  // 空文字 = 明示的な「連携しない」（既定にも送らない）なので、空文字もそのまま送る。
  if (githubRepo !== undefined) body.github_repo = githubRepo;
  // 対象のプロダクト・アプリ（ADR-0031）。指定するとセッションを product に従属させ、
  // API 側で product の索引済み repo を継承する。空/未指定は従来どおりの単発セッション。
  if (productId) body.product_id = productId;
  // 準備フォームのゴール・詳細（ADR-0035）。SessionMeta に保存され、agent が起動時に
  // 初期 instructions へシードする（join 後の RAG 投入と違い agent 起動に確実に間に合う）。
  if (goal?.trim()) body.goal = goal;
  if (goalDetail?.trim()) body.goal_detail = goalDetail;
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: authHeaders(idToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return res.json();
}

// context 投稿は join 済みトークン（session_token）で認可される（契約 §4）。
// 匿名アクセスを塞ぐため、join 後に取得した session_token を Bearer に渡す。
export async function addSessionContext(
  sessionId: string,
  text: string,
  sessionToken: string | null,
  sourceName = "uploaded",
): Promise<{ indexed_chunks: number }> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/context`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ text, source_name: sourceName }),
  });
  if (!res.ok) throw new Error(`add context failed: ${res.status}`);
  return res.json();
}

// ── 画像/動画アップロード（ADR-0004）───────────────────────
// 画像/動画を context/file へ送り、安定 asset_id を受け取る。web はこの asset_id で
// analysis.progress / analysis.visual（契約 §3）をファイル行へ対応付ける。

/** 受理する拡張子 → MIME（要件票 06: 画像 PNG/JPG・動画 MP4/MOV）。 */
export const ACCEPTED_IMAGE = ".png,.jpg,.jpeg,image/png,image/jpeg";
export const ACCEPTED_VIDEO = ".mp4,.mov,video/mp4,video/quicktime";
/** 資料（テキスト/文書）。API 側の許可リスト（storage.py TEXT_EXT/DOC_BINARY_EXT）と揃える。 */
export const ACCEPTED_DOC =
  ".txt,.md,.markdown,.pdf,.html,.htm,.csv,.json,.docx,.xlsx,.pptx," +
  "text/plain,text/markdown,text/html,text/csv,application/json,application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** 受理形式の利用者向け説明（エラー文言・シートの副題で共有する）。 */
export const ACCEPTED_SUMMARY =
  "画像 PNG/JPG・動画 MP4/MOV・資料 PDF/Word/Excel/PowerPoint/Markdown/HTML/CSV 等";

const IMAGE_EXT = [".png", ".jpg", ".jpeg"];
const VIDEO_EXT = [".mp4", ".mov"];
const DOC_EXT = [
  ".txt",
  ".md",
  ".markdown",
  ".pdf",
  ".html",
  ".htm",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  ".pptx",
];
const IMAGE_MIME = ["image/png", "image/jpeg"];
const VIDEO_MIME = ["video/mp4", "video/quicktime"];
const DOC_MIME = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/** アップロード種別（API の asset_kind と同語彙）。doc = テキスト抽出する資料。 */
export type UploadKind = "image" | "video" | "doc";

/** 拡張子からアップロード種別を判定（非対応は null）。ピッカ前段の早期弾き用。 */
export function classifyUpload(filename: string): UploadKind | null {
  const name = filename.toLowerCase();
  if (IMAGE_EXT.some((e) => name.endsWith(e))) return "image";
  if (VIDEO_EXT.some((e) => name.endsWith(e))) return "video";
  if (DOC_EXT.some((e) => name.endsWith(e))) return "doc";
  return null;
}

/**
 * 受理判定は API（content-type）と揃える。拡張子（classifyUpload）に加えて MIME も見る
 * ことで、.jfif や拡張子なしでも MIME が正しければ受理する。
 */
export function classifyFileUpload(file: { name: string; type: string }): UploadKind | null {
  const byName = classifyUpload(file.name);
  if (byName) return byName;
  const type = file.type.toLowerCase();
  if (IMAGE_MIME.includes(type)) return "image";
  if (VIDEO_MIME.includes(type)) return "video";
  if (DOC_MIME.includes(type)) return "doc";
  return null;
}

export interface UploadResult {
  indexed_chunks: number;
  asset_id?: string;
  asset_kind?: UploadKind;
  analysis_pending?: boolean;
}

/**
 * POST /api/sessions/{id}/context/file（画像/動画）。FormData で送る。
 *
 * signal（任意）を渡すと、中断で AbortController.abort() により送信中の fetch を中止できる。
 * 中止時は fetch が AbortError で reject する（呼び出し側で signal.aborted を見て failed と区別する）。
 * 既存呼び出しは signal 省略でそのまま動く（後方互換）。
 */
export async function uploadContextFile(
  sessionId: string,
  file: File,
  sessionToken: string | null,
  signal?: AbortSignal,
): Promise<UploadResult> {
  // 動画は GCS へ直送する（ADR-0040。Cloud Run の HTTP/1 32MiB 制限を回避）。動画解析が
  // サーバで無効なとき（upload-init が 409）は従来の multipart「準備中」へフォールバックする。
  if (classifyFileUpload(file) === "video") {
    const direct = await uploadVideoDirect(sessionId, file, sessionToken, signal);
    if (direct !== "disabled") return direct;
  }
  const form = new FormData();
  form.append("file", file);
  // context/file は join 済みトークン必須（契約 §4）。multipart の boundary はブラウザに
  // 任せるため Content-Type は付けず、Authorization だけ手で付ける。
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/context/file`, {
    method: "POST",
    headers,
    body: form,
    signal,
  });
  if (res.status === 415) throw new Error(`対応していない形式です（${ACCEPTED_SUMMARY}）`);
  if (res.status === 413) throw new Error("ファイルが大きすぎます");
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json();
}

interface UploadInitResult {
  asset_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * 動画の GCS 直送（ADR-0040 §2）: upload-init（署名付き URL）→ ブラウザから GCS へ PUT →
 * upload-complete（検証 + 解析 enqueue）。動画解析がサーバで無効なら "disabled" を返し、
 * 呼び出し側が multipart へフォールバックする。中断は signal で PUT を中止できる。
 */
async function uploadVideoDirect(
  sessionId: string,
  file: File,
  sessionToken: string | null,
  signal?: AbortSignal,
): Promise<UploadResult | "disabled"> {
  const contentType = file.type || "video/mp4";
  const init = await fetch(`${API_URL}/api/sessions/${sessionId}/context/file/upload-init`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ filename: file.name, content_type: contentType, size: file.size }),
    signal,
  });
  if (init.status === 409) return "disabled"; // 動画解析が無効 → multipart フォールバック
  if (init.status === 413) throw new Error("動画が大きすぎます（最大 200MB）");
  if (init.status === 415) throw new Error("対応していない形式です（MP4/MOV）");
  if (!init.ok) throw new Error(`upload-init failed: ${init.status}`);
  const plan: UploadInitResult = await init.json();

  // 署名付き URL へブラウザから直接 PUT（api を経由しない）。署名対象ヘッダをそのまま付ける。
  const put = await fetch(plan.upload_url, {
    method: plan.method || "PUT",
    headers: plan.headers,
    body: file,
    signal,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  const done = await fetch(`${API_URL}/api/sessions/${sessionId}/context/file/upload-complete`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({
      asset_id: plan.asset_id,
      content_type: contentType,
      filename: file.name,
    }),
    signal,
  });
  if (done.status === 413) throw new Error("動画が大きすぎます（最大 200MB）");
  if (!done.ok) throw new Error(`upload-complete failed: ${done.status}`);
  return done.json();
}

// ── 素材の観測テレメトリ（投入種別 / 中断）─────────────────────
// 投入種別/中断を console ではなくサーバ側 OTLP カウンタへ集約する。第三者クライアント分析
// SDK は導入せず、既存 metrics 基盤（apps/api observability.py）に載せる（CLAUDE.md 原則3）。
// PII/自由記述は送らない: 列挙属性のみ（source/status/result）。

/**
 * 受け付けるイベント種別（API 側の許可リストと一致）。
 * join.abort はリンク入場（/join）でセッション作成後に会話開始へ至らず離脱した事象
 * （FR-2.1 ゲスト経路の離脱観測 / ADR-0032）。result=aborted は利用者の中断、
 * error は接続・マイク失敗による離脱。
 */
export type TelemetryEvent = "material.source_selected" | "material.cancel" | "join.abort";

/** 列挙属性のみ（PII/自由記述は送らない）。API 側で許可リスト検証される。 */
export interface TelemetryAttrs {
  /** 投入種別。 */
  source?: "camera" | "screen" | "upload" | "drive";
  /** 中断対象の状態。 */
  status?: "uploading" | "analyzing";
  /** 中断結果（abort 有無・破棄失敗）/ join.abort の離脱要因。 */
  result?: "aborted" | "discarded" | "error";
}

/**
 * POST /api/sessions/{id}/telemetry。素材 UI イベントをサーバ集計へ送る。
 *
 * 観測は UX を止めない: 送信は best-effort で、失敗（ネットワーク/401/422）は握りつぶす。
 * ページ遷移中でも届くよう keepalive を付ける。返り値は無し（送信の成否で分岐させない）。
 */
export function sendTelemetry(
  sessionId: string,
  event: TelemetryEvent,
  attrs: TelemetryAttrs,
  sessionToken: string | null,
): void {
  try {
    void fetch(`${API_URL}/api/sessions/${sessionId}/telemetry`, {
      method: "POST",
      headers: authHeaders(sessionToken),
      body: JSON.stringify({ event, ...attrs }),
      keepalive: true,
    }).catch(() => {
      /* 観測は補助。送信失敗で UX を止めない。 */
    });
  } catch {
    /* fetch が同期 throw（環境差）しても握りつぶす。 */
  }
}

export interface DeleteContextFileResult {
  /** 常に true（冪等な破棄要求が受理された）。 */
  deleted: boolean;
  /** サーバに実体（binary/メタ/索引）が在って消したか。 */
  existed: boolean;
}

/**
 * DELETE /api/sessions/{id}/context/file/{assetId}（真の破棄）。
 *
 * 投入済み素材の binary・material メタ・grounding 索引をサーバでまとめて取り消す。冪等
 * （存在しない asset でも 2xx）。中断確定時に呼び、成功でローカル破棄を確定する。失敗時は
 * 例外を投げ、呼び出し側がローカル破棄の維持/再試行を判断する。
 */
export async function deleteContextFile(
  sessionId: string,
  assetId: string,
  sessionToken: string | null,
): Promise<DeleteContextFileResult> {
  const res = await fetch(
    `${API_URL}/api/sessions/${sessionId}/context/file/${encodeURIComponent(assetId)}`,
    { method: "DELETE", headers: authHeaders(sessionToken) },
  );
  if (!res.ok) throw new Error(`delete context file failed: ${res.status}`);
  return res.json();
}

// ── ハイドレーション（契約 §4）─────────────────────────────
// リロード・途中参加時に現在状態を取得し、データチャネルのライブ差分と合流させる。

export interface RequirementsSnapshot {
  items: Requirement[];
  /** 適用済み連番。これ以下のライブイベントは破棄する（境界）。 */
  seq: number;
}

export interface DetectionsSnapshot {
  items: Detection[];
  seq?: number;
}

/** GET /questions/current のスナップショット（ADR-0020）。 */
export interface CurrentQuestionSnapshot {
  /** 現在の未回答質問。回答済み/未提示なら null。 */
  question: Question | null;
  /** asked_seq（active）または cleared_seq（回答済み）。null でも順序情報として返る（§5-4）。 */
  seq: number;
}

/** GET /context/files の 1 行（契約 §4）。realtime の analysis 行と asset_id で突き合わせる。 */
export interface ContextFileItem {
  id: string;
  name: string;
  kind: UploadKind;
  status: "uploading" | "analyzing" | "done" | "failed";
  extracted?: number;
}

export interface ContextFilesSnapshot {
  items: ContextFileItem[];
}

// 以下のハイドレーション/起票 API は join 済みトークン（session_token）を Bearer に渡す。

/** GET /api/sessions/{id}/requirements（P0）。確定/下書き要件のスナップショット。 */
export async function fetchRequirements(
  sessionId: string,
  sessionToken: string | null,
): Promise<RequirementsSnapshot> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/requirements`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch requirements failed: ${res.status}`);
  return res.json();
}

/** GET /api/sessions/{id}/context/files。投入済み素材のメタ（実ファイル名・状態）。 */
export async function fetchContextFiles(
  sessionId: string,
  sessionToken: string | null,
): Promise<ContextFilesSnapshot> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/context/files`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch context files failed: ${res.status}`);
  return res.json();
}

/** GET /api/sessions/{id}/questions/current。現在の未回答質問（金枠ピン）の復元。 */
export async function fetchCurrentQuestion(
  sessionId: string,
  sessionToken: string | null,
): Promise<CurrentQuestionSnapshot> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/questions/current`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch current question failed: ${res.status}`);
  return res.json();
}

/** GET /api/sessions/{id}/detections?open=1（P1）。未解消の矛盾/抜け。 */
export async function fetchDetections(
  sessionId: string,
  sessionToken: string | null,
): Promise<DetectionsSnapshot> {
  const res = await fetch(
    `${API_URL}/api/sessions/${sessionId}/detections?open=1`,
    { headers: authHeaders(sessionToken) },
  );
  if (!res.ok) throw new Error(`fetch detections failed: ${res.status}`);
  return res.json();
}

export interface ExportResult {
  exported: boolean;
  issue_url?: string;
  count?: number;
  doc_url?: string;
  reason?: string;
}

export interface FinalizeResult {
  finalized: boolean;
  confirmed_count: number;
}

/** POST /api/sessions/{id}/finalize。07 判定の「確定」を永続化する。 */
export async function finalizeSession(
  sessionId: string,
  sessionToken: string | null,
): Promise<FinalizeResult> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/finalize`, {
    method: "POST",
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`finalize failed: ${res.status}`);
  return res.json();
}

/** POST /api/sessions/{id}/export（P1）。要件を GitHub Issue に書き戻す。 */
export async function exportRequirements(
  sessionId: string,
  sessionToken: string | null,
): Promise<ExportResult> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/export`, {
    method: "POST",
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  return res.json();
}

// ── 本人のセッション履歴 ──────────────────────────
// ホーム「過去の要件を見る」履歴リストに供給する。認証は Google idToken（ADR-0012）で、
// API 側が owner_sub 一致のものだけを新しい順で返す（認可は本人限定）。PII（owner_email 等）は
// レスポンスに含めない。

/** GET /api/sessions/mine の 1 行。本人のセッション（過去の要件）の最小メタ。 */
export interface MySession {
  id: string;
  title: string;
  /** ISO 8601 の作成時刻。表示用の整形は呼び出し側で行う。 */
  created_at: string;
  status: string;
  /** 07 判定で確定済みか。 */
  finalized: boolean;
}

/**
 * GET /api/sessions/mine。ログインユーザー本人のセッション一覧を新しい順で取得する。
 *
 * 認証は Google idToken（ADR-0012）。owner_sub が一致するもののみ API 側で返る（本人限定）。
 * 失敗時は例外を投げ、呼び出し側（ホーム）が空状態を維持するか判断する。
 */
export async function fetchMySessions(idToken: string | null): Promise<MySession[]> {
  const res = await fetch(`${API_URL}/api/sessions/mine`, {
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`fetch my sessions failed: ${res.status}`);
  return res.json();
}

/** `GET /api/github/repos`（ADR-0027）。02 準備「連携リポジトリ」の候補一覧。 */
export interface GithubRepos {
  /** コネクタ/App 連携のいずれかが使える状態か。false なら UI はフィールドごと隠す。 */
  enabled: boolean;
  /** 選べる "owner/name" の一覧（更新が新しい順）。空なら手入力へフォールバック。 */
  repos: string[];
  /** 環境変数の既定リポジトリ（あれば初期選択に使える）。 */
  default: string | null;
  /**
   * 本人が GitHub App 連携済みで一覧が App 由来か（ADR-0028 / additive）。
   * true のとき UI は branch 選択と開始時の索引キックを有効化する。
   */
  linked?: boolean;
  /** App 由来のときの詳細（default_branch / private）。connector 由来では省略/空。 */
  items?: GitHubRepoItem[];
}

/**
 * GET /api/github/repos（ADR-0027）。セッション実施前に選べるリポジトリ候補を取得する。
 * 認証は Google idToken（ADR-0012）。失敗時は例外を投げ、呼び出し側（02 準備）が
 * フィールド非表示のまま開始を止めないことを判断する。
 */
export async function fetchGithubRepos(idToken: string | null): Promise<GithubRepos> {
  const res = await fetch(`${API_URL}/api/github/repos`, {
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`fetch github repos failed: ${res.status}`);
  return res.json();
}

/** GET /api/sessions/mine/{id}/requirements の応答。過去要件の絵巻閲覧画面（/sessions/[id]）用。 */
export interface MySessionRequirements {
  id: string;
  title: string;
  /** ISO 8601 の作成時刻。表示用の整形は呼び出し側で行う。 */
  created_at: string;
  /** 07 判定で確定済みか。 */
  finalized: boolean;
  /** 契約 §3 の requirement 形（会話中のハイドレーションと同じ）。 */
  items: Requirement[];
}

/**
 * GET /api/sessions/mine/{id}/requirements。本人の過去セッションの要件絵巻を取得する。
 *
 * 会話終了後は join 済み session_token が残らないため、認証は Google idToken（ADR-0012）。
 * 非所有・不存在はどちらも 404（存在を応答差で漏らさない）。404 は ApiError で投げ、
 * 呼び出し側（/sessions/[id]）が「見つからない」表示に分岐する。
 */
export async function fetchMySessionRequirements(
  sessionId: string,
  idToken: string | null,
): Promise<MySessionRequirements> {
  const res = await fetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/requirements`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `fetch my session requirements failed: ${res.status}`);
  return res.json();
}

/** 要件結果ドキュメントの読み手（出力フォーマットの選択キー）。 */
export type Audience = "end_user" | "planner" | "developer";

/** GET /api/sessions/mine/{id}/result-document の応答。 */
export interface ResultDocument {
  audience: Audience;
  /** アプリ管理画面で登録されたフォーマットが使われたか（false = 既定テンプレート）。 */
  is_custom_format: boolean;
  markdown: string;
}

/**
 * GET /api/sessions/mine/{id}/result-document。要件結果を audience（利用者/企画者/開発者）別の
 * 出力フォーマットで整形した Markdown を取得する。認証・404 の意味論は
 * fetchMySessionRequirements と同じ（本人限定 / 存在秘匿）。
 */
export async function fetchMySessionResultDocument(
  sessionId: string,
  audience: Audience,
  idToken: string | null,
): Promise<ResultDocument> {
  const res = await fetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/result-document?audience=${audience}`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `fetch result document failed: ${res.status}`);
  return res.json();
}

export async function joinSession(params: {
  invite: string;
  participantName: string;
  idToken: string | null;
}): Promise<JoinResponse> {
  const res = await fetch(`${API_URL}/api/sessions/join`, {
    method: "POST",
    headers: authHeaders(params.idToken),
    body: JSON.stringify({
      invite: params.invite,
      participant_name: params.participantName,
    }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  return res.json();
}

// ---- Admin (ADR-0014) ------------------------------------------------------
// 認可の源泉は常に API 側 (ADMIN_EMAILS 照合)。クライアントは 401/403 を受けて再認証や
// アクセス不可表示に遷移するだけ (§7)。

/** API エラー。status を持たせ、401/403 をクライアントで分岐できるようにする。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AdminSession {
  id: string;
  title: string;
  owner_sub: string;
  owner_email: string;
  roles: string[];
  status: string;
  created_at: string;
}

async function adminFetch<T>(path: string, idToken: string | null, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(idToken), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // 401/403 は呼び出し側 (admin ページ) がガード/再認証に使うため status を保持する。
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// 旧「93 要件を検める」の listSessionRequirements / updateRequirement は管理画面の
// 要件確認廃止に伴い削除した。要件の閲覧は本人限定の fetchMySessionRequirements が担う。
export function listAdminSessions(idToken: string | null): Promise<AdminSession[]> {
  return adminFetch<AdminSession[]>("/api/admin/sessions", idToken);
}

// ===== GitHub repo linking (ADR-0028) =======================================

export interface GitHubLinkStatus {
  linked: boolean;
  github_login: string | null;
}

export interface GitHubRepoItem {
  full_name: string;
  default_branch: string;
  private: boolean;
}

export interface GitHubBranchItem {
  name: string;
  sha: string;
}

export interface SessionGitHub {
  repo: string | null;
  branch: string | null;
  commit_sha: string | null;
  // none | pending | indexing | ready | partial | failed
  status: string;
}

// 連携状態の取得・開始・解除は Google idToken（require_user）で認可される。
export async function getGithubLinkStatus(idToken: string | null): Promise<GitHubLinkStatus> {
  const res = await fetch(`${API_URL}/api/github/link`, { headers: authHeaders(idToken) });
  if (!res.ok) throw new Error(`github link status failed: ${res.status}`);
  return res.json();
}

export async function startGithubLink(idToken: string | null): Promise<{ install_url: string }> {
  const res = await fetch(`${API_URL}/api/github/link/start`, {
    method: "POST",
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`github link start failed: ${res.status}`);
  return res.json();
}

export async function unlinkGithub(idToken: string | null): Promise<GitHubLinkStatus> {
  const res = await fetch(`${API_URL}/api/github/link`, {
    method: "DELETE",
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`github unlink failed: ${res.status}`);
  return res.json();
}

// repo 候補一覧は fetchGithubRepos（GET /api/github/repos）に統一されている（ADR-0027）。
// App 連携済みなら linked=true と items（default_branch/private 付き）が載る。

export async function listGithubBranches(
  repo: string,
  idToken: string | null,
): Promise<GitHubBranchItem[]> {
  const res = await fetch(
    `${API_URL}/api/github/branches?repo=${encodeURIComponent(repo)}`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new Error(`github branches failed: ${res.status}`);
  return (await res.json()).items;
}

// ===== Products: アプリと深掘りリンク (ADR-0031) ==============================
// 認証はすべて Google idToken（require_user）。認可の源泉は API 側
// （_require_product_access）で、非所有・不存在はどちらも 404 が返る（存在秘匿）。
// web は 404 を「見つからない」表示に平すだけで、owner 判定を複製しない。

/** GET/POST /api/products の 1 件（ProductResponse）。owner_sub は API が返さない。 */
export interface Product {
  id: string;
  name: string;
  /**
   * URL キーワード（グローバル一意 / ADR-0045）。/{slug}/prepare 等のアプリ従属 URL の
   * 識別子。null = 未設定（slug 導入前の既存アプリ）。未設定の間は壁打ちを開始できない。
   */
  slug: string | null;
  description: string;
  /** 利用者向け語彙（画面名・機能の呼び名）。end_user モードのプロンプトにシードされる。 */
  glossary: string[];
  created_at: string;
  github_repo: string | null;
  github_branch: string | null;
  github_commit_sha: string | null;
  // none | pending | indexing | ready | partial | failed
  github_index_status: string;
  /**
   * 呼び出しユーザーから見た役割（ADR-0036。admin は owner に平される）。
   * web は管理 UI（編集・招待・削除）の出し分けにのみ使う。認可の源泉は常に API 側。
   */
  role: "owner" | "member";
  /** 要件結果の出力フォーマット（audience → Markdown テンプレート。未登録キーは無い）。 */
  output_formats: Partial<Record<Audience, string>>;
  /** 未登録の audience に使われる既定テンプレート（表示用の参照値。正はサーバ側）。 */
  output_format_defaults: Record<Audience, string>;
  /** 要件サンバ中に必ず確認する項目（対象タグ付き。上限は check_items_limit）。 */
  check_items: CheckItem[];
  /** 確認項目の登録上限（正はサーバ側 MAX_CHECK_ITEMS。web は定数を複製しない）。 */
  check_items_limit: number;
}

/** 確認項目 1 件。target は対象ペルソナ（null = 全員）。 */
export interface CheckItem {
  text: string;
  target: Audience | null;
}

/** 深掘りリンク 1 件（ProductInviteResponse）。token から /join/{token} URL を組む。 */
export interface ProductInvite {
  id: string;
  scope: "developer" | "end_user";
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  revoked: boolean;
  created_at: string;
  token: string;
}

/** products 系の共通 fetch。404（存在秘匿）等を ApiError で返し、呼び出し側が分岐する。 */
async function productFetch<T>(
  path: string,
  idToken: string | null,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(idToken), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function createProduct(
  name: string,
  slug: string,
  description: string,
  idToken: string | null,
): Promise<Product> {
  return productFetch<Product>("/api/products", idToken, {
    method: "POST",
    body: JSON.stringify({ name, slug, description }),
  });
}

export function fetchMyProducts(idToken: string | null): Promise<Product[]> {
  return productFetch<Product[]>("/api/products/mine", idToken);
}

export function fetchProduct(productId: string, idToken: string | null): Promise<Product> {
  return productFetch<Product>(`/api/products/${encodeURIComponent(productId)}`, idToken);
}

export function updateProduct(
  productId: string,
  patch: {
    name?: string;
    /** URL キーワード（グローバル一意 / ADR-0045）。変更すると /{slug}/... の URL も変わる。 */
    slug?: string;
    description?: string;
    glossary?: string[];
    /** audience → テンプレートの全量置換。空文字の値は「未登録＝既定へ戻す」。 */
    output_formats?: Partial<Record<Audience, string>>;
    /** 確認項目の全量置換（上限は Product.check_items_limit）。 */
    check_items?: CheckItem[];
  },
  idToken: string | null,
): Promise<Product> {
  return productFetch<Product>(`/api/products/${encodeURIComponent(productId)}`, idToken, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteProduct(
  productId: string,
  idToken: string | null,
): Promise<{ deleted: boolean }> {
  return productFetch<{ deleted: boolean }>(
    `/api/products/${encodeURIComponent(productId)}`,
    idToken,
    { method: "DELETE" },
  );
}

/**
 * POST /api/products/{id}/github。product に前提 repo を紐づけ非同期索引をキックする。
 * セッション版（selectSessionRepo / session_token）と違い、owner の idToken で認可される。
 */
export function selectProductRepo(
  productId: string,
  repo: string,
  branch: string | null,
  idToken: string | null,
): Promise<SessionGitHub> {
  const body: Record<string, unknown> = { repo };
  if (branch) body.branch = branch;
  return productFetch<SessionGitHub>(
    `/api/products/${encodeURIComponent(productId)}/github`,
    idToken,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function createProductInvite(
  productId: string,
  params: { scope: "developer" | "end_user"; ttlSeconds?: number; maxUses?: number },
  idToken: string | null,
): Promise<ProductInvite> {
  const body: Record<string, unknown> = { scope: params.scope };
  // 未指定（undefined）は「制限なし」= API に送らない（None 既定に委ねる）。
  if (params.ttlSeconds !== undefined) body.ttl_seconds = params.ttlSeconds;
  if (params.maxUses !== undefined) body.max_uses = params.maxUses;
  return productFetch<ProductInvite>(
    `/api/products/${encodeURIComponent(productId)}/invites`,
    idToken,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function listProductInvites(
  productId: string,
  idToken: string | null,
): Promise<ProductInvite[]> {
  return productFetch<ProductInvite[]>(
    `/api/products/${encodeURIComponent(productId)}/invites`,
    idToken,
  );
}

export function revokeProductInvite(
  productId: string,
  inviteId: string,
  idToken: string | null,
): Promise<ProductInvite> {
  return productFetch<ProductInvite>(
    `/api/products/${encodeURIComponent(productId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
    idToken,
    { method: "POST" },
  );
}

// ===== Product members: メンバー管理・招待 (ADR-0036) =========================
// メンバー = その product で要件サンバができる人。招待はメールアドレス宛の 1 回限りで、
// メール URL（/member-invites/{token}）とアプリ内通知（fetchMyMemberInvites）の
// どちらからでも承諾/辞退できる。認可の源泉は API 側（_require_product_access）。

/** GET /api/products/{id}/members の 1 件。owner はここに含まれない（owner_sub が正）。 */
export interface ProductMember {
  sub: string;
  email: string;
  display_name: string;
  created_at: string;
}

/** メンバー招待 1 件（管理 UI 用）。token から /member-invites/{token} の URL を組める。 */
export interface ProductMemberInvite {
  id: string;
  email: string;
  // pending | accepted | declined | revoked | expired（expired は期限からの導出）
  status: string;
  created_at: string;
  expires_at: string | null;
  invited_by_email: string;
  token: string;
}

/** GET /api/member-invites/mine の 1 件（アプリ内通知）。 */
export interface MyMemberInvite {
  id: string;
  product_id: string;
  product_name: string;
  invited_by_email: string;
  created_at: string;
  expires_at: string | null;
}

/** POST /api/member-invites/resolve の応答（招待 URL の承諾前確認）。 */
export interface MemberInviteResolution {
  id: string;
  product_name: string;
  invited_by_email: string;
  /** 宛先の伏せ字（本人確認前のため完全な宛先は返らない）。 */
  masked_email: string;
  status: string;
  /** ログイン中のアカウントが宛先本人か（承諾ボタンの活性判定）。 */
  email_match: boolean;
}

export function fetchProductMembers(
  productId: string,
  idToken: string | null,
): Promise<ProductMember[]> {
  return productFetch<ProductMember[]>(
    `/api/products/${encodeURIComponent(productId)}/members`,
    idToken,
  );
}

export function removeProductMember(
  productId: string,
  memberSub: string,
  idToken: string | null,
): Promise<{ removed: boolean }> {
  return productFetch<{ removed: boolean }>(
    `/api/products/${encodeURIComponent(productId)}/members/${encodeURIComponent(memberSub)}`,
    idToken,
    { method: "DELETE" },
  );
}

export function createMemberInvite(
  productId: string,
  email: string,
  idToken: string | null,
): Promise<ProductMemberInvite> {
  return productFetch<ProductMemberInvite>(
    `/api/products/${encodeURIComponent(productId)}/member-invites`,
    idToken,
    { method: "POST", body: JSON.stringify({ email }) },
  );
}

export function listMemberInvites(
  productId: string,
  idToken: string | null,
): Promise<ProductMemberInvite[]> {
  return productFetch<ProductMemberInvite[]>(
    `/api/products/${encodeURIComponent(productId)}/member-invites`,
    idToken,
  );
}

export function revokeMemberInvite(
  productId: string,
  inviteId: string,
  idToken: string | null,
): Promise<ProductMemberInvite> {
  return productFetch<ProductMemberInvite>(
    `/api/products/${encodeURIComponent(productId)}/member-invites/${encodeURIComponent(inviteId)}/revoke`,
    idToken,
    { method: "POST" },
  );
}

export function fetchMyMemberInvites(idToken: string | null): Promise<MyMemberInvite[]> {
  return productFetch<MyMemberInvite[]>("/api/member-invites/mine", idToken);
}

/** アプリ内通知からの承諾/辞退（招待 id 経由）。 */
export function respondMemberInvite(
  inviteId: string,
  action: "accept" | "decline",
  idToken: string | null,
): Promise<{ status: string; product_id: string }> {
  return productFetch<{ status: string; product_id: string }>(
    `/api/member-invites/${encodeURIComponent(inviteId)}/respond`,
    idToken,
    { method: "POST", body: JSON.stringify({ action }) },
  );
}

/**
 * 招待 URL のトークンを検証して確認画面用の情報を得る。トークンは URL パスに現れるが
 * API へは body で渡す（アクセスログに残さない / products/join と同方針）。
 */
export function resolveMemberInvite(
  token: string,
  idToken: string | null,
): Promise<MemberInviteResolution> {
  return productFetch<MemberInviteResolution>("/api/member-invites/resolve", idToken, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** 招待メール URL からの承諾/辞退（トークン経由。宛先 email と一致しないと 403）。 */
export function respondMemberInviteByToken(
  token: string,
  action: "accept" | "decline",
  idToken: string | null,
): Promise<{ status: string; product_id: string }> {
  return productFetch<{ status: string; product_id: string }>(
    "/api/member-invites/respond-by-token",
    idToken,
    { method: "POST", body: JSON.stringify({ token, action }) },
  );
}

/** POST /api/products/join の応答（api の ProductJoinResponse と同形 / ADR-0032 決定1）。 */
export interface ProductJoinResult {
  session_id: string;
  /**
   * ログイン済み入場: 既存 POST /api/sessions/join へ渡す役割 invite
   * （LiveKit トークン交換は join に委譲）。ゲスト入場では null。
   */
  invite: string | null;
  product_id: string;
  product_name: string;
  interview_mode: "developer" | "end_user";
  /**
   * ゲスト入場（Authorization 無し・guest_join_enabled・scope=end_user）のときのみ非 null。
   * sessions/join を経由せず、LiveKit トークン + session_token をここで直接受け取る。
   * ログイン済みは従来どおり null（invite 経由）。
   */
  join: JoinResponse | null;
}

/**
 * POST /api/products/join。深掘りリンクを検証・消費し、product 従属セッションを自動作成する。
 *
 * **呼ぶたびにリンクの use_count を 1 消費する**（ADR-0031 決定3）。ページ表示や
 * 自動リトライで無駄撃ちしないこと（呼び出しは「開始する」タップの 1 回だけ）。
 * 失敗は ApiError で投げ、message に API の detail（403 の expired / revoked /
 * exhausted 等）を保持する — /join 画面がエラーの出し分けに使う。
 */
export async function joinProduct(
  token: string,
  consentAcknowledged: boolean,
  idToken: string | null,
): Promise<ProductJoinResult> {
  const res = await fetch(`${API_URL}/api/products/join`, {
    method: "POST",
    headers: authHeaders(idToken),
    body: JSON.stringify({ token, consent_acknowledged: consentAcknowledged }),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { detail?: unknown }) => String(b?.detail ?? ""))
      .catch(() => "");
    throw new ApiError(res.status, detail || `join product failed: ${res.status}`);
  }
  return res.json();
}

// repo 選択・状態取得は join 済みトークン（session_token / 契約 §4）で認可される。
export async function selectSessionRepo(
  sessionId: string,
  repo: string,
  branch: string | null,
  sessionToken: string | null,
): Promise<SessionGitHub> {
  const body: Record<string, unknown> = { repo };
  if (branch) body.branch = branch;
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/github`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`select repo failed: ${res.status}`);
  return res.json();
}

export async function getSessionRepo(
  sessionId: string,
  sessionToken: string | null,
): Promise<SessionGitHub> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/github`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`get session repo failed: ${res.status}`);
  return res.json();
}
