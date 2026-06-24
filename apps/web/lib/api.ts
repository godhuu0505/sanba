import type { Detection, Requirement } from "./realtime/types";

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
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: authHeaders(idToken),
    body: JSON.stringify({ roles, consent_acknowledged: consentAcknowledged }),
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
