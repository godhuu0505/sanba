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
): Promise<CreateSessionResponse> {
  const body: Record<string, unknown> = { roles, consent_acknowledged: consentAcknowledged };
  // title 未指定なら API 既定 ("要件インタビュー") に委ねる。
  if (title !== undefined) body.title = title;
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

/** POST /api/sessions/{id}/context/file（画像/動画）。FormData で送る。 */
export async function uploadContextFile(
  sessionId: string,
  file: File,
  sessionToken: string | null,
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
  });
  if (res.status === 415) throw new Error("対応していない形式です（PNG/JPG・MP4/MOV）");
  if (res.status === 413) throw new Error("ファイルが大きすぎます");
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
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
