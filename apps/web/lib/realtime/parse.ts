
import {
  type Priority,
  type RequirementCategory,
  type RequirementStatus,
  SCHEMA_VERSION,
  type ServerEvent,
  type ServerEventType,
  type SessionPhase,
  type UserAnsweredEvent,
  type UserInquiryDropEvent,
  type UserSelectionEvent,
  type UserTextEvent,
} from "./types";

const KNOWN_TYPES: ReadonlySet<string> = new Set<ServerEventType>([
  "status",
  "transcript.partial",
  "transcript.final",
  "inquiry.node",
  "requirement.upserted",
  "question.asked",
  "question.cleared",
  "analysis.progress",
  "analysis.visual",
  "context.progress",
  "session.end_proposed",
  "session.completed",
]);

export interface DecodeResult {
  event: ServerEvent | null;
  reason:
    | "ok"
    | "not-json"
    | "bad-envelope"
    | "unknown-type"
    | "version"
    | "bad-payload";
}

const REQUIRED_FIELDS: Record<ServerEventType, readonly string[]> = {
  status: ["phase"],
  "transcript.partial": ["speaker", "role", "utterance_id", "text"],
  "transcript.final": ["speaker", "role", "utterance_id", "text"],
  "inquiry.node": ["op", "node"],
  "requirement.upserted": ["requirement"],
  "question.asked": ["id", "prompt"],
  "question.cleared": ["question_id"],
  "analysis.progress": ["asset_id", "pct", "stage"],
  "analysis.visual": ["asset_id", "extracted", "conflicts"],
  "context.progress": ["source", "stage"],
  "session.end_proposed": ["open_count", "requirement_count", "material_count"],
  "session.completed": ["summary", "artifacts"],
};

const REQUIREMENT_FIELDS = [
  "id",
  "statement",
  "category",
  "priority",
  "confidence",
  "source_speaker",
  "citations",
  "status",
] as const;

function hasFields(obj: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((f) => obj[f] !== undefined && obj[f] !== null);
}

const PHASES: ReadonlySet<string> = new Set<SessionPhase>([
  "idle",
  "listening",
  "recognizing",
  "deliberating",
]);
const PRIORITIES: ReadonlySet<string> = new Set<Priority>(["must", "should", "could", "wont"]);
const CATEGORIES: ReadonlySet<string> = new Set<RequirementCategory>([
  "functional",
  "non_functional",
  "constraint",
  "scope",
  "open_question",
]);
const REQ_STATUSES: ReadonlySet<string> = new Set<RequirementStatus>(["draft", "confirmed"]);
const CONTEXT_STAGES: ReadonlySet<string> = new Set<string>([
  "running",
  "done",
  "reused",
  "partial",
  "failed",
]);
const INQUIRY_OPS: ReadonlySet<string> = new Set<string>(["upsert", "resolve", "drop"]);
const INQUIRY_KINDS: ReadonlySet<string> = new Set<string>([
  "gap",
  "contradiction",
  "ambiguous",
  "check",
]);
const INQUIRY_STATUSES: ReadonlySet<string> = new Set<string>(["open", "resolved", "dropped"]);

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function validatePayload(type: ServerEventType, obj: Record<string, unknown>): boolean {
  switch (type) {
    case "status":
      return PHASES.has(obj.phase as string);
    case "inquiry.node": {
      if (!INQUIRY_OPS.has(obj.op as string)) return false;
      const node = obj.node;
      if (typeof node !== "object" || node === null) return false;
      const n = node as Record<string, unknown>;
      return (
        typeof n.id === "string" &&
        (n.parent_id === null || typeof n.parent_id === "string") &&
        INQUIRY_KINDS.has(n.kind as string) &&
        typeof n.text === "string" &&
        INQUIRY_STATUSES.has(n.status as string) &&
        isNumberInRange(n.confidence, 0, 1) &&
        typeof n.depth === "number" &&
        typeof n.origin === "string" &&
        isStringArray(n.refs) &&
        typeof n.created_seq === "number" &&
        (n.resolved_seq === null || typeof n.resolved_seq === "number")
      );
    }
    case "analysis.progress":
      return isNumberInRange(obj.pct, 0, 100);
    case "context.progress":
      return (
        (obj.source === "prep" || obj.source === "repo") &&
        CONTEXT_STAGES.has(obj.stage as string)
      );
    case "session.end_proposed":
      return (
        typeof obj.open_count === "number" &&
        typeof obj.requirement_count === "number" &&
        typeof obj.material_count === "number"
      );
    case "analysis.visual":
      return Array.isArray(obj.extracted) && Array.isArray(obj.conflicts);
    case "session.completed": {
      const s = obj.summary;
      if (typeof s !== "object" || s === null) return false;
      const sm = s as Record<string, unknown>;
      return (
        typeof sm.contradictions_resolved === "number" &&
        typeof sm.gaps_found === "number" &&
        typeof sm.issues_created === "number" &&
        Array.isArray(obj.artifacts)
      );
    }
    case "requirement.upserted": {
      const req = obj.requirement as Record<string, unknown>;
      return (
        PRIORITIES.has(req.priority as string) &&
        CATEGORIES.has(req.category as string) &&
        REQ_STATUSES.has(req.status as string) &&
        isNumberInRange(req.confidence, 0, 1) &&
        Array.isArray(req.citations)
      );
    }
    default:
      return true;
  }
}

const decoder = new TextDecoder();

export function decodeServerEvent(payload: Uint8Array | string): DecodeResult {
  let raw: unknown;
  try {
    const text = typeof payload === "string" ? payload : decoder.decode(payload);
    raw = JSON.parse(text);
  } catch {
    return { event: null, reason: "not-json" };
  }

  if (typeof raw !== "object" || raw === null) {
    return { event: null, reason: "bad-envelope" };
  }
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.type !== "string" ||
    typeof obj.seq !== "number" ||
    typeof obj.ts !== "string" ||
    typeof obj.session_id !== "string" ||
    typeof obj.v !== "number"
  ) {
    return { event: null, reason: "bad-envelope" };
  }
  if (obj.v !== SCHEMA_VERSION) {
    return { event: null, reason: "version" };
  }
  if (!KNOWN_TYPES.has(obj.type)) {
    return { event: null, reason: "unknown-type" };
  }

  const type = obj.type as ServerEventType;
  if (!hasFields(obj, REQUIRED_FIELDS[type])) {
    return { event: null, reason: "bad-payload" };
  }
  if (type === "requirement.upserted") {
    const req = obj.requirement;
    if (
      typeof req !== "object" ||
      req === null ||
      !hasFields(req as Record<string, unknown>, REQUIREMENT_FIELDS)
    ) {
      return { event: null, reason: "bad-payload" };
    }
  }

  if (!validatePayload(type, obj)) {
    return { event: null, reason: "bad-payload" };
  }

  return { event: obj as unknown as ServerEvent, reason: "ok" };
}

const encoder = new TextEncoder();

export function encodeUserSelection(
  sessionId: string,
  detectionId: string,
  selectedValue: string,
  seq: number,
  ts: string,
): Uint8Array {
  const event: UserSelectionEvent = {
    v: SCHEMA_VERSION,
    type: "user.selection",
    seq,
    ts,
    session_id: sessionId,
    detection_id: detectionId,
    selected_value: selectedValue,
  };
  return encoder.encode(JSON.stringify(event));
}

export function encodeUserText(
  sessionId: string,
  text: string,
  seq: number,
  ts: string,
): Uint8Array {
  const event: UserTextEvent = {
    v: SCHEMA_VERSION,
    type: "user.text",
    seq,
    ts,
    session_id: sessionId,
    text,
  };
  return encoder.encode(JSON.stringify(event));
}

export function encodeUserAnswered(
  sessionId: string,
  questionId: string,
  answer: { selectedValue?: string; text?: string },
  seq: number,
  ts: string,
): Uint8Array {
  const event: UserAnsweredEvent = {
    v: SCHEMA_VERSION,
    type: "user.answered",
    seq,
    ts,
    session_id: sessionId,
    question_id: questionId,
    ...(answer.selectedValue !== undefined ? { selected_value: answer.selectedValue } : {}),
    ...(answer.text !== undefined ? { text: answer.text } : {}),
  };
  return encoder.encode(JSON.stringify(event));
}

export function encodeUserInquiryDrop(
  sessionId: string,
  nodeId: string,
  seq: number,
  ts: string,
): Uint8Array {
  const event: UserInquiryDropEvent = {
    v: SCHEMA_VERSION,
    type: "user.inquiry_drop",
    seq,
    ts,
    session_id: sessionId,
    node_id: nodeId,
  };
  return encoder.encode(JSON.stringify(event));
}
