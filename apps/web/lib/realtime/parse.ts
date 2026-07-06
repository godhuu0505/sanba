// データチャネルで届く UTF-8 JSON を検証して ServerEvent に絞り込む。
// 契約 §2 のエンベロープ必須フィールド（v/type/seq/ts/session_id）を満たさない
// メッセージは捨てる（不正な送信元・将来スキーマからの保護）。

import {
  type Priority,
  type RequirementCategory,
  type RequirementStatus,
  SCHEMA_VERSION,
  type ServerEvent,
  type ServerEventType,
  type SessionPhase,
  type UserAnsweredEvent,
  type UserSelectionEvent,
  type UserTextEvent,
} from "./types";

const KNOWN_TYPES: ReadonlySet<string> = new Set<ServerEventType>([
  "status",
  "transcript.partial",
  "transcript.final",
  "detection.contradiction",
  "detection.gap",
  "detection.ambiguous",
  "detection.resolved",
  "requirement.upserted",
  "question.asked",
  "question.cleared",
  "analysis.progress",
  "analysis.visual",
  "session.completed",
]);

export interface DecodeResult {
  event: ServerEvent | null;
  /** 破棄理由（観測性・デバッグ用）。null なし。 */
  reason:
    | "ok"
    | "not-json"
    | "bad-envelope"
    | "unknown-type"
    | "version"
    | "bad-payload";
}

// 種別ごとの必須フィールド（契約 §3）。エンベロープが正しくても、ここを満たさない
// 不完全メッセージは ServerEvent として通さない（store.apply が落ちるのを防ぐ）。
const REQUIRED_FIELDS: Record<ServerEventType, readonly string[]> = {
  status: ["phase"],
  "transcript.partial": ["speaker", "role", "utterance_id", "text"],
  "transcript.final": ["speaker", "role", "utterance_id", "text"],
  "detection.contradiction": ["id", "summary", "refs", "detector"],
  "detection.gap": ["id", "summary", "category", "refs", "detector"],
  "detection.ambiguous": ["id", "summary", "refs", "detector"],
  "detection.resolved": ["detection_id", "resolution"],
  "requirement.upserted": ["requirement"],
  "question.asked": ["id", "prompt"],
  "question.cleared": ["question_id"],
  "analysis.progress": ["asset_id", "pct", "stage"],
  "analysis.visual": ["asset_id", "extracted", "conflicts"],
  "session.completed": ["summary", "artifacts"],
};

// requirement.upserted の入れ子 requirement の必須フィールド。
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

// enum 値の許可集合（types.ts と一致）。受信境界で列挙外の値を弾き、セレクタ
// （priority/category で索引）や UI が未知値で TypeError/誤表示にならないよう守る。
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

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * 種別ごとの enum / 配列 / 数値範囲の網羅検証。必須フィールドの存在（hasFields）に加え、
 * 値が契約の許可集合・型・範囲に収まることを確認する。外れたら false（bad-payload で破棄）。
 * presence は呼び出し側で検証済みの前提（REQUIRED_FIELDS / REQUIREMENT_FIELDS）。
 */
function validatePayload(type: ServerEventType, obj: Record<string, unknown>): boolean {
  switch (type) {
    case "status":
      return PHASES.has(obj.phase as string);
    case "detection.contradiction":
      return isStringArray(obj.refs);
    case "detection.gap":
      return isStringArray(obj.refs) && typeof obj.category === "string";
    case "detection.ambiguous":
      return isStringArray(obj.refs);
    case "analysis.progress":
      // pct は 0–100 の進捗率。範囲外（負値・100 超・NaN）は誤った進捗バーになるため弾く。
      return isNumberInRange(obj.pct, 0, 100);
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

/** 生バイト列（または文字列）を 1 件の ServerEvent にデコードする。 */
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
    // 既知フィールドは前方互換だが、メジャー不一致は安全側に倒して破棄する。
    return { event: null, reason: "version" };
  }
  if (!KNOWN_TYPES.has(obj.type)) {
    return { event: null, reason: "unknown-type" };
  }

  // 種別ごとの必須ペイロードまで検証してから ok にする（受信境界の堅牢化）。
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

  // enum / 配列 / 範囲の網羅検証。presence を満たしても値が契約外なら破棄する。
  if (!validatePayload(type, obj)) {
    return { event: null, reason: "bad-payload" };
  }

  return { event: obj as unknown as ServerEvent, reason: "ok" };
}

const encoder = new TextEncoder();

/**
 * web → agent の user.selection をエンベロープ込みでエンコードする（契約 §4.5）。
 * 検知カードの選択肢タップ時に topic="sanba.events.web" へ publish する。
 * seq は web 発の単調増加（agent 側 seq とは別空間）。
 */
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

/**
 * web → agent の user.text をエンコードする（契約 §4.5）。
 * ボトムバーのテキスト送信を「会話ターン」として agent に渡す（従来のセッション文脈投入の代替）。
 */
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

/**
 * web → agent の user.answered をエンコードする（契約 §4.5）。
 * 通常質問（金枠）の選択肢タップ／自由記述回答を agent に返す。
 */
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
