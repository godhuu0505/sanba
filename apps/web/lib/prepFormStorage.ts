
const KEY = "sanba.prep.v1";

export interface PrepForm {
  role?: string;
  goal?: string;
  goalDetail?: string;
  consent?: boolean;
  productId?: string;
}

export function readPrep(): PrepForm {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    const out: PrepForm = {};
    if (typeof o.role === "string") out.role = o.role;
    if (typeof o.goal === "string") out.goal = o.goal;
    if (typeof o.goalDetail === "string") out.goalDetail = o.goalDetail;
    if (typeof o.consent === "boolean") out.consent = o.consent;
    if (typeof o.productId === "string") out.productId = o.productId;
    return out;
  } catch {
    return {};
  }
}

export function writePrep(form: PrepForm): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(form));
  } catch {
  }
}

export function clearPrep(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
  }
}
