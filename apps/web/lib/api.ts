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

export async function addSessionContext(
  sessionId: string,
  text: string,
  sourceName = "uploaded",
): Promise<{ indexed_chunks: number }> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source_name: sourceName }),
  });
  if (!res.ok) throw new Error(`add context failed: ${res.status}`);
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
