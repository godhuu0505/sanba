import type { Detection, Question, Requirement } from "./realtime/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// 検証済み identity を API に運ぶ (ADR-0012)。idToken が null (dev モード) のときは
// Authorization を付けず、API 側の AUTH_DEV_BYPASS に委ねる。
function authHeaders(idToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
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
): Promise<CreateSessionResponse> {
  const body: Record<string, unknown> = { roles, consent_acknowledged: consentAcknowledged };
  // title 未指定なら API 既定 ("要件インタビュー") に委ねる。
  if (title !== undefined) body.title = title;
  // 連携リポジトリ（任意 / ADR-0027）。未指定・空は「連携しない」= 送らない。
  if (githubRepo) body.github_repo = githubRepo;
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

// ── 画像/動画アップロード（Issue #103 / ADR-0004）───────────────────────
// 画像/動画を context/file へ送り、安定 asset_id を受け取る。web はこの asset_id で
// analysis.progress / analysis.visual（契約 §3）をファイル行へ対応付ける。

/** 受理する拡張子 → MIME（要件票 06: 画像 PNG/JPG・動画 MP4/MOV）。 */
export const ACCEPTED_IMAGE = ".png,.jpg,.jpeg,image/png,image/jpeg";
export const ACCEPTED_VIDEO = ".mp4,.mov,video/mp4,video/quicktime";

const IMAGE_EXT = [".png", ".jpg", ".jpeg"];
const VIDEO_EXT = [".mp4", ".mov"];

/** 拡張子からアップロード種別を判定（非対応は null）。ピッカ前段の早期弾き用。 */
export function classifyUpload(filename: string): "image" | "video" | null {
  const name = filename.toLowerCase();
  if (IMAGE_EXT.some((e) => name.endsWith(e))) return "image";
  if (VIDEO_EXT.some((e) => name.endsWith(e))) return "video";
  return null;
}

export interface UploadResult {
  indexed_chunks: number;
  asset_id?: string;
  asset_kind?: "image" | "video";
  analysis_pending?: boolean;
}

/**
 * POST /api/sessions/{id}/context/file（画像/動画）。FormData で送る。
 *
 * signal（任意）を渡すと、中断（#219）で AbortController.abort() により送信中の fetch を中止できる。
 * 中止時は fetch が AbortError で reject する（呼び出し側で signal.aborted を見て failed と区別する）。
 * 既存呼び出しは signal 省略でそのまま動く（後方互換）。
 */
export async function uploadContextFile(
  sessionId: string,
  file: File,
  sessionToken: string | null,
  signal?: AbortSignal,
): Promise<UploadResult> {
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
  if (res.status === 415) throw new Error("対応していない形式です（PNG/JPG・MP4/MOV）");
  if (res.status === 413) throw new Error("ファイルが大きすぎます");
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json();
}

// ── 素材の観測テレメトリ（#232 投入種別 / #243 中断）─────────────────────
// 投入種別/中断を console ではなくサーバ側 OTLP カウンタへ集約する。第三者クライアント分析
// SDK は導入せず、既存 metrics 基盤（apps/api observability.py）に載せる（CLAUDE.md 原則3）。
// PII/自由記述は送らない: 列挙属性のみ（source/status/result）。

/** 受け付けるイベント種別（API 側の許可リストと一致）。 */
export type TelemetryEvent = "material.source_selected" | "material.cancel";

/** 列挙属性のみ（PII/自由記述は送らない）。API 側で許可リスト検証される。 */
export interface TelemetryAttrs {
  /** #232 投入種別。 */
  source?: "camera" | "screen" | "upload" | "drive";
  /** #243 中断対象の状態。 */
  status?: "uploading" | "analyzing";
  /** #243 中断結果（abort 有無・破棄失敗）。 */
  result?: "aborted" | "discarded" | "error";
}

/**
 * POST /api/sessions/{id}/telemetry（#232/#243）。素材 UI イベントをサーバ集計へ送る。
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
      /* 観測は補助。送信失敗で UX を止めない（#243）。 */
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
 * DELETE /api/sessions/{id}/context/file/{assetId}（#245 真の破棄）。
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

// ── ハイドレーション（契約 §4 / Issue #100）─────────────────────────────
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

/** GET /questions/current のスナップショット（#212 / ADR-0020）。 */
export interface CurrentQuestionSnapshot {
  /** 現在の未回答質問。回答済み/未提示なら null。 */
  question: Question | null;
  /** asked_seq（active）または cleared_seq（回答済み）。null でも順序情報として返る（§5-4）。 */
  seq: number;
}

/** GET /context/files の 1 行（契約 §4 #184）。realtime の analysis 行と asset_id で突き合わせる。 */
export interface ContextFileItem {
  id: string;
  name: string;
  kind: "image" | "video";
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

/** GET /api/sessions/{id}/context/files（#184）。投入済み素材のメタ（実ファイル名・状態）。 */
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

/** GET /api/sessions/{id}/questions/current（#212）。現在の未回答質問（金枠ピン）の復元。 */
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

/** POST /api/sessions/{id}/finalize（#186）。07 判定の「確定」を永続化する。 */
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

/** POST /api/sessions/{id}/export（P1）。要件を GitHub Issue に書き戻す（#39）。 */
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

// ── 本人のセッション履歴（#250 / #215 follow-up）──────────────────────────
// ホーム「過去の要件を見る」履歴リストに供給する。認証は Google idToken（ADR-0012）で、
// API 側が owner_sub 一致のものだけを新しい順で返す（認可は本人限定）。PII（owner_email 等）は
// レスポンスに含めない。

/** GET /api/sessions/mine の 1 行（#250）。本人のセッション（過去の要件）の最小メタ。 */
export interface MySession {
  id: string;
  title: string;
  /** ISO 8601 の作成時刻。表示用の整形は呼び出し側で行う。 */
  created_at: string;
  status: string;
  /** 07 判定で確定済みか（#186）。 */
  finalized: boolean;
}

/**
 * GET /api/sessions/mine（#250）。ログインユーザー本人のセッション一覧を新しい順で取得する。
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
  /** コネクタが使える状態か。false なら UI はフィールドごと隠す。 */
  enabled: boolean;
  /** 選べる "owner/name" の一覧（更新が新しい順）。空なら手入力へフォールバック。 */
  repos: string[];
  /** 環境変数の既定リポジトリ（あれば初期選択に使える）。 */
  default: string | null;
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

export type RequirementStatus = "draft" | "approved" | "rejected";

export interface AdminSession {
  id: string;
  title: string;
  owner_sub: string;
  owner_email: string;
  roles: string[];
  status: string;
  created_at: string;
}

export interface AdminRequirement {
  id: string;
  category: string;
  statement: string;
  priority: string;
  source_speaker: string | null;
  confidence: number;
  created_at: string;
  status: RequirementStatus;
  approved_by: string | null;
  approved_at: string | null;
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

export function listAdminSessions(idToken: string | null): Promise<AdminSession[]> {
  return adminFetch<AdminSession[]>("/api/admin/sessions", idToken);
}

export function listSessionRequirements(
  sessionId: string,
  idToken: string | null,
): Promise<AdminRequirement[]> {
  return adminFetch<AdminRequirement[]>(
    `/api/admin/sessions/${sessionId}/requirements`,
    idToken,
  );
}

export function updateRequirement(
  sessionId: string,
  rid: string,
  patch: {
    statement?: string;
    priority?: string;
    category?: string;
    status?: RequirementStatus;
  },
  idToken: string | null,
): Promise<AdminRequirement> {
  return adminFetch<AdminRequirement>(
    `/api/admin/sessions/${sessionId}/requirements/${rid}`,
    idToken,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}
