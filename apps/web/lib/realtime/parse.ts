// データチャネルで届く UTF-8 JSON を検証して ServerEvent に絞り込む。
// 契約 §2 のエンベロープ必須フィールド（v/type/seq/ts/session_id）を満たさない
// メッセージは捨てる（不正な送信元・将来スキーマからの保護）。

import {
  SCHEMA_VERSION,
  type ServerEvent,
  type ServerEventType,
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
 * web → agent の user.text をエンコードする（契約 §4.5 / #185）。
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
 * web → agent の user.answered をエンコードする（契約 §4.5 / #181）。
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
