import type { InquiryNode, Question, Requirement } from "./realtime/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

let currentAuthNonce: string | null = null;

export function setAuthNonce(envelope: string | null): void {
  currentAuthNonce = envelope;
}

export interface AuthNonce {
  nonce: string;
  token: string;
  expires_at: number;
}

export async function fetchAuthNonce(): Promise<AuthNonce | null> {
  try {
    const res = await apiFetch(`${API_URL}/api/auth/nonce`, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as AuthNonce;
  } catch {
    return null;
  }
}

export interface SessionProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
  expires_at: number;
  idle_expires_at: number;
}

export async function fetchSessionMe(): Promise<SessionProfile | null> {
  try {
    const res = await apiFetch(`${API_URL}/api/session/me`, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as SessionProfile;
  } catch {
    return null;
  }
}

export async function revokeSession(): Promise<void> {
  try {
    await apiFetch(`${API_URL}/api/session`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
  }
}

export async function exchangeIdToken(
  idToken: string,
  nonceEnvelope: string | null,
): Promise<SessionProfile | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (nonceEnvelope) headers["X-Auth-Nonce"] = nonceEnvelope;
    const res = await apiFetch(`${API_URL}/api/session/exchange`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ id_token: idToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionProfile;
  } catch {
    return null;
  }
}

function authHeaders(idToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  if (currentAuthNonce) headers["X-Auth-Nonce"] = currentAuthNonce;
  return headers;
}

function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { credentials: "include", ...init });
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
  session_token: string;
  results_viewable?: boolean;
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
  if (title !== undefined) body.title = title;
  if (githubRepo !== undefined) body.github_repo = githubRepo;
  if (productId) body.product_id = productId;
  if (goal?.trim()) body.goal = goal;
  if (goalDetail?.trim()) body.goal_detail = goalDetail;
  const res = await apiFetch(`${API_URL}/api/sessions`, {
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
  sessionToken: string | null,
  sourceName = "uploaded",
): Promise<{ indexed_chunks: number }> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/context`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ text, source_name: sourceName }),
  });
  if (!res.ok) throw new Error(`add context failed: ${res.status}`);
  return res.json();
}


export const ACCEPTED_IMAGE = ".png,.jpg,.jpeg,image/png,image/jpeg";
export const ACCEPTED_VIDEO = ".mp4,.mov,video/mp4,video/quicktime";
export const ACCEPTED_DOC =
  ".txt,.md,.markdown,.pdf,.html,.htm,.csv,.json,.docx,.xlsx,.pptx," +
  "text/plain,text/markdown,text/html,text/csv,application/json,application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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

export type UploadKind = "image" | "video" | "doc";

export function classifyUpload(filename: string): UploadKind | null {
  const name = filename.toLowerCase();
  if (IMAGE_EXT.some((e) => name.endsWith(e))) return "image";
  if (VIDEO_EXT.some((e) => name.endsWith(e))) return "video";
  if (DOC_EXT.some((e) => name.endsWith(e))) return "doc";
  return null;
}

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

export async function uploadContextFile(
  sessionId: string,
  file: File,
  sessionToken: string | null,
  signal?: AbortSignal,
): Promise<UploadResult> {
  if (classifyFileUpload(file) === "video") {
    const direct = await uploadVideoDirect(sessionId, file, sessionToken, signal);
    if (direct !== "disabled") return direct;
  }
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/context/file`, {
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

async function uploadVideoDirect(
  sessionId: string,
  file: File,
  sessionToken: string | null,
  signal?: AbortSignal,
): Promise<UploadResult | "disabled"> {
  const contentType = file.type || "video/mp4";
  const init = await apiFetch(`${API_URL}/api/sessions/${sessionId}/context/file/upload-init`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ filename: file.name, content_type: contentType, size: file.size }),
    signal,
  });
  if (init.status === 409) return "disabled";
  if (init.status === 413) throw new Error("動画が大きすぎます（最大 200MB）");
  if (init.status === 415) throw new Error("対応していない形式です（MP4/MOV）");
  if (!init.ok) throw new Error(`upload-init failed: ${init.status}`);
  const plan: UploadInitResult = await init.json();

  const put = await fetch(plan.upload_url, {
    method: plan.method || "PUT",
    headers: plan.headers,
    body: file,
    signal,
  });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);

  const done = await apiFetch(`${API_URL}/api/sessions/${sessionId}/context/file/upload-complete`, {
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


export type TelemetryEvent = "material.source_selected" | "material.cancel" | "join.abort";

export interface TelemetryAttrs {
  source?: "camera" | "screen" | "upload" | "drive";
  status?: "uploading" | "analyzing";
  result?: "aborted" | "discarded" | "error";
}

export function sendTelemetry(
  sessionId: string,
  event: TelemetryEvent,
  attrs: TelemetryAttrs,
  sessionToken: string | null,
): void {
  try {
    void apiFetch(`${API_URL}/api/sessions/${sessionId}/telemetry`, {
      method: "POST",
      headers: authHeaders(sessionToken),
      body: JSON.stringify({ event, ...attrs }),
      keepalive: true,
    }).catch(() => {
    });
  } catch {
  }
}

export interface DeleteContextFileResult {
  deleted: boolean;
  existed: boolean;
}

export async function deleteContextFile(
  sessionId: string,
  assetId: string,
  sessionToken: string | null,
): Promise<DeleteContextFileResult> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/${sessionId}/context/file/${encodeURIComponent(assetId)}`,
    { method: "DELETE", headers: authHeaders(sessionToken) },
  );
  if (!res.ok) throw new Error(`delete context file failed: ${res.status}`);
  return res.json();
}


export interface RequirementsSnapshot {
  items: Requirement[];
  seq: number;
}

export interface InquirySnapshot {
  nodes: InquiryNode[];
  seq: number;
}

export interface CurrentQuestionSnapshot {
  question: Question | null;
  seq: number;
}

export interface ContextFileItem {
  id: string;
  name: string;
  kind: UploadKind;
  status: "uploading" | "analyzing" | "done" | "failed";
  extracted?: number;
  extracted_texts?: string[];
}

export interface ContextFilesSnapshot {
  items: ContextFileItem[];
}


export async function fetchRequirements(
  sessionId: string,
  sessionToken: string | null,
): Promise<RequirementsSnapshot> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/requirements`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch requirements failed: ${res.status}`);
  return res.json();
}

export async function fetchContextFiles(
  sessionId: string,
  sessionToken: string | null,
): Promise<ContextFilesSnapshot> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/context/files`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch context files failed: ${res.status}`);
  return res.json();
}

export async function fetchCurrentQuestion(
  sessionId: string,
  sessionToken: string | null,
): Promise<CurrentQuestionSnapshot> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/questions/current`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch current question failed: ${res.status}`);
  return res.json();
}

export async function fetchInquiry(
  sessionId: string,
  sessionToken: string | null,
): Promise<InquirySnapshot> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/inquiry`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`fetch inquiry failed: ${res.status}`);
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

export interface FinalizeOptions {
  forced?: boolean;
}

export async function finalizeSession(
  sessionId: string,
  sessionToken: string | null,
  options: FinalizeOptions = {},
): Promise<FinalizeResult> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/finalize`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({ forced: options.forced ?? false }),
  });
  if (!res.ok) throw new Error(`finalize failed: ${res.status}`);
  return res.json();
}

export interface ExportOptions {
  includeSummary?: boolean;
  includeMaterials?: boolean;
}

export async function exportRequirements(
  sessionId: string,
  sessionToken: string | null,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/export`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify({
      include_summary: options.includeSummary ?? false,
      include_materials: options.includeMaterials ?? false,
    }),
  });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  return res.json();
}

export interface ExportEligibility {
  can_export: boolean;
  reason?: string;
  repo?: string | null;
}

export async function fetchExportEligibility(
  sessionId: string,
  sessionToken: string | null,
): Promise<ExportEligibility> {
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/export/eligibility`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`export eligibility failed: ${res.status}`);
  return res.json();
}


export interface MySession {
  id: string;
  title: string;
  created_at: string;
  status: string;
  finalized: boolean;
  labels?: string[];
  issue_url?: string | null;
}

export async function fetchMySessions(idToken: string | null): Promise<MySession[]> {
  const res = await apiFetch(`${API_URL}/api/sessions/mine`, {
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`fetch my sessions failed: ${res.status}`);
  return res.json();
}

export interface GithubRepos {
  enabled: boolean;
  repos: string[];
  default: string | null;
  linked?: boolean;
  items?: GitHubRepoItem[];
}

export async function fetchGithubRepos(idToken: string | null): Promise<GithubRepos> {
  const res = await apiFetch(`${API_URL}/api/github/repos`, {
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`fetch github repos failed: ${res.status}`);
  return res.json();
}

export interface SessionMaterial {
  id: string;
  name: string;
  kind: string;
  status: string;
}

export interface OpenInquiry {
  id: string;
  kind: string;
  text: string;
}

export interface MySessionRequirements {
  id: string;
  title: string;
  created_at: string;
  finalized: boolean;
  goal?: string | null;
  goal_detail?: string | null;
  materials?: SessionMaterial[];
  open_inquiries?: OpenInquiry[];
  items: Requirement[];
}

export async function fetchMySessionRequirements(
  sessionId: string,
  idToken: string | null,
): Promise<MySessionRequirements> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/requirements`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `fetch my session requirements failed: ${res.status}`);
  return res.json();
}

export type Audience = "end_user" | "planner" | "developer";

export interface ResultDocument {
  audience: Audience;
  is_custom_format: boolean;
  markdown: string;
}

export async function fetchMySessionResultDocument(
  sessionId: string,
  audience: Audience,
  idToken: string | null,
): Promise<ResultDocument> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/result-document?audience=${encodeURIComponent(audience)}`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `fetch result document failed: ${res.status}`);
  return res.json();
}

export interface TranscriptUtterance {
  speaker: string;
  text: string;
  ts: string;
}

export interface SessionTranscript {
  id: string;
  utterances: TranscriptUtterance[];
}

export async function fetchMySessionTranscript(
  sessionId: string,
  idToken: string | null,
): Promise<SessionTranscript> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/transcript`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `fetch my session transcript failed: ${res.status}`);
  return res.json();
}

export async function fetchMyExportEligibility(
  sessionId: string,
  idToken: string | null,
): Promise<ExportEligibility> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/export/eligibility`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `export eligibility failed: ${res.status}`);
  return res.json();
}

export async function exportMyRequirements(
  sessionId: string,
  idToken: string | null,
): Promise<ExportResult> {
  const res = await apiFetch(
    `${API_URL}/api/sessions/mine/${encodeURIComponent(sessionId)}/export`,
    { method: "POST", headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new ApiError(res.status, `export failed: ${res.status}`);
  return res.json();
}

export async function joinSession(params: {
  invite: string;
  participantName: string;
  idToken: string | null;
}): Promise<JoinResponse> {
  const res = await apiFetch(`${API_URL}/api/sessions/join`, {
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


export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}


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
  status: string;
}

export async function getGithubLinkStatus(idToken: string | null): Promise<GitHubLinkStatus> {
  const res = await apiFetch(`${API_URL}/api/github/link`, { headers: authHeaders(idToken) });
  if (!res.ok) throw new Error(`github link status failed: ${res.status}`);
  return res.json();
}

export async function startGithubLink(idToken: string | null): Promise<{ install_url: string }> {
  const res = await apiFetch(`${API_URL}/api/github/link/start`, {
    method: "POST",
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`github link start failed: ${res.status}`);
  return res.json();
}

export async function unlinkGithub(idToken: string | null): Promise<GitHubLinkStatus> {
  const res = await apiFetch(`${API_URL}/api/github/link`, {
    method: "DELETE",
    headers: authHeaders(idToken),
  });
  if (!res.ok) throw new Error(`github unlink failed: ${res.status}`);
  return res.json();
}


export async function listGithubBranches(
  repo: string,
  idToken: string | null,
): Promise<GitHubBranchItem[]> {
  const res = await apiFetch(
    `${API_URL}/api/github/branches?repo=${encodeURIComponent(repo)}`,
    { headers: authHeaders(idToken) },
  );
  if (!res.ok) throw new Error(`github branches failed: ${res.status}`);
  return (await res.json()).items;
}


export interface Product {
  id: string;
  name: string;
  slug: string | null;
  description: string;
  glossary: string[];
  created_at: string;
  github_repo: string | null;
  github_branch: string | null;
  github_commit_sha: string | null;
  github_index_status: string;
  role: "owner" | "member";
  output_formats: Partial<Record<Audience, string>>;
  output_format_defaults: Record<Audience, string>;
  check_items: CheckItem[];
  check_items_limit: number;
  check_point_defaults: Record<string, string[]>;
}

export interface CheckItem {
  text: string;
  target: Audience | null;
}

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

async function productFetch<T>(
  path: string,
  idToken: string | null,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(`${API_URL}${path}`, {
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
    slug?: string;
    description?: string;
    glossary?: string[];
    output_formats?: Partial<Record<Audience, string>>;
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


export interface ProductMember {
  sub: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface ProductMemberInvite {
  id: string;
  email: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  invited_by_email: string;
  token: string;
}

export interface MyMemberInvite {
  id: string;
  product_id: string;
  product_name: string;
  invited_by_email: string;
  created_at: string;
  expires_at: string | null;
}

export interface MemberInviteResolution {
  id: string;
  product_name: string;
  invited_by_email: string;
  masked_email: string;
  status: string;
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

export function resolveMemberInvite(
  token: string,
  idToken: string | null,
): Promise<MemberInviteResolution> {
  return productFetch<MemberInviteResolution>("/api/member-invites/resolve", idToken, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

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

export interface ProductJoinResult {
  session_id: string;
  invite: string | null;
  product_id: string;
  product_name: string;
  interview_mode: "developer" | "end_user";
  join: JoinResponse | null;
}

export async function joinProduct(
  token: string,
  consentAcknowledged: boolean,
  idToken: string | null,
): Promise<ProductJoinResult> {
  const res = await apiFetch(`${API_URL}/api/products/join`, {
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

export async function selectSessionRepo(
  sessionId: string,
  repo: string,
  branch: string | null,
  sessionToken: string | null,
): Promise<SessionGitHub> {
  const body: Record<string, unknown> = { repo };
  if (branch) body.branch = branch;
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/github`, {
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
  const res = await apiFetch(`${API_URL}/api/sessions/${sessionId}/github`, {
    headers: authHeaders(sessionToken),
  });
  if (!res.ok) throw new Error(`get session repo failed: ${res.status}`);
  return res.json();
}
