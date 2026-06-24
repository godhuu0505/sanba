// データチャネルで届く UTF-8 JSON を検証して ServerEvent に絞り込む。
// 契約 §2 のエンベロープ必須フィールド（v/type/seq/ts/session_id）を満たさない
// メッセージは捨てる（不正な送信元・将来スキーマからの保護）。

import { SCHEMA_VERSION, type ServerEvent, type ServerEventType } from "./types";

const KNOWN_TYPES: ReadonlySet<string> = new Set<ServerEventType>([
  "status",
  "transcript.partial",
  "transcript.final",
  "detection.contradiction",
  "detection.gap",
  "detection.resolved",
  "requirement.upserted",
  "analysis.progress",
  "analysis.visual",
  "session.completed",
]);

export interface DecodeResult {
  event: ServerEvent | null;
  /** 破棄理由（観測性・デバッグ用）。null なら成功。 */
  reason: "ok" | "not-json" | "bad-envelope" | "unknown-type" | "version" | null;
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

  return { event: obj as unknown as ServerEvent, reason: "ok" };
}
