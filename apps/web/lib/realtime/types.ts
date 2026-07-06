// リアルタイム契約（docs/design/realtime-contract.md §2/§3/§4.5）の TypeScript 表現。
// agent → web のデータチャネル・イベントと、GET ハイドレーションのスナップショット、
// web → agent のユーザー操作（user.selection）を型として固定する。
//
// 命名は契約どおり「機能名」（detector / source_speaker）で持ち、緋/黄土などの擬人化・
// 色トークンへの写像は UI 層（mapping.ts）に閉じ込める（契約 §3 注記）。

/** 現行スキーマ版（契約 §2 `v`）。 */
export const SCHEMA_VERSION = 1 as const;

/** agent → web のデータチャネル topic（契約 §1）。 */
export const EVENTS_TOPIC = "sanba.events";
/** web → agent のデータチャネル topic（契約 §4.5）。 */
export const WEB_EVENTS_TOPIC = "sanba.events.web";

// ── §3 ペイロード構成要素 ───────────────────────────────────────────────

export type SessionPhase =
  | "idle"
  | "listening"
  | "recognizing"
  | "deliberating";

export type RequirementCategory =
  | "functional"
  | "non_functional"
  | "constraint"
  | "scope"
  | "open_question";

export type Priority = "must" | "should" | "could" | "wont";

export type RequirementStatus = "draft" | "confirmed";

export interface Citation {
  /** 例: "utterance" | "asset" など根拠の種類。 */
  kind: string;
  /** 根拠への参照（utterance_id / asset_id など）。 */
  ref: string;
}

export interface Requirement {
  id: string;
  statement: string;
  category: RequirementCategory;
  priority: Priority;
  /** 0–1。 */
  confidence: number;
  source_speaker: string;
  citations: Citation[];
  status: RequirementStatus;
}

export type DetectionKind = "contradiction" | "gap" | "ambiguous";

export interface DetectionOption {
  label: string;
  value: string;
}

/** `detection.contradiction` / `detection.gap` を web 内部で正規化した形。 */
export interface Detection {
  id: string;
  kind: DetectionKind;
  summary: string;
  /** 根拠の発話 ID（transcript.final の utterance_id と同一空間）。 */
  refs: string[];
  /** 抜け（gap）のみ: カテゴリ。 */
  category?: string;
  /** 選択肢（任意）。あればユーザーがタップして user.selection を返す。 */
  options?: DetectionOption[];
  /** 機能名の検知器（例 contradiction_detector / scope_specialist）。 */
  detector: string;
  /** 解消済みか。detection.resolved 受信で true。 */
  resolved: boolean;
  /** 解消の種別。 */
  resolution?: "user_selected" | "agent_resolved";
  /** ユーザーが選んだ値（user_selected のとき）。 */
  selected_value?: string;
}

export interface AnalysisVisualConflict {
  summary: string;
  refs: string[];
}

/** 通常質問（金枠・契約 §3）。検知（緋/黄土）とは別に、次に聞く1問を提示する。 */
export interface Question {
  id: string;
  prompt: string;
  /** 選択肢（任意）。あればタップで user.answered を返す。無ければ自由記述（音声/テキスト）。 */
  options: DetectionOption[];
}

// ── §2 エンベロープ + §3 イベント ──────────────────────────────────────

interface Envelope<T extends string> {
  v: number;
  type: T;
  /**
   * reliable ストリームの単調増加連番（整列・重複排除・欠番検知の基準 / 契約 §2）。
   * lossy イベント（status/transcript.partial）は reliable seq を消費せず**現在値を echo**する
   * ため、その seq は欠番検知に使わない。lossy の順序は `lossy_seq` で持つ。
   */
  seq: number;
  /**
   * reliable イベントか（既定 true）。false = lossy（status/transcript.partial）。
   * 欠番検知・maxSeq 前進は reliable のみ対象にする。古い agent（フィールド無し）は true 扱い。
   */
  reliable?: boolean;
  /** lossy イベント専用の単調増加連番。lossy の順序・重複排除に使う（reliable には無い）。 */
  lossy_seq?: number;
  /** ISO8601（agent 側の発行時刻）。 */
  ts: string;
  session_id: string;
}

export type StatusEvent = Envelope<"status"> & {
  phase: SessionPhase;
  agents_active?: number;
};

export type TranscriptPartialEvent = Envelope<"transcript.partial"> & {
  speaker: string;
  role: string;
  utterance_id: string;
  text: string;
};

export type TranscriptFinalEvent = Envelope<"transcript.final"> & {
  speaker: string;
  role: string;
  utterance_id: string;
  text: string;
};

export type DetectionContradictionEvent = Envelope<"detection.contradiction"> & {
  id: string;
  summary: string;
  refs: string[];
  options?: DetectionOption[];
  detector: string;
};

export type DetectionGapEvent = Envelope<"detection.gap"> & {
  id: string;
  summary: string;
  category: string;
  refs: string[];
  detector: string;
};

export type DetectionAmbiguousEvent = Envelope<"detection.ambiguous"> & {
  id: string;
  summary: string;
  refs: string[];
  detector: string;
};

export type DetectionResolvedEvent = Envelope<"detection.resolved"> & {
  detection_id: string;
  resolution: "user_selected" | "agent_resolved";
  selected_value?: string;
};

export type RequirementUpsertedEvent = Envelope<"requirement.upserted"> & {
  requirement: Requirement;
};

export type AnalysisProgressEvent = Envelope<"analysis.progress"> & {
  asset_id: string;
  pct: number;
  stage: string;
};

export type AnalysisVisualEvent = Envelope<"analysis.visual"> & {
  asset_id: string;
  extracted: string[];
  conflicts: AnalysisVisualConflict[];
};

export type QuestionAskedEvent = Envelope<"question.asked"> & {
  id: string;
  prompt: string;
  options?: DetectionOption[];
};

/**
 * 現在質問のクリアを全参加者へ伝播するライブイベント（契約 §2 / ADR-0020 §5-5）。
 * 回答（タップ / 音声 / テキスト）で current question が tombstone 化されたときに publish される。
 * `cleared_seq` は本イベントの **envelope `seq` そのもの**（二重採番しない）。web は seq ガードで
 * 当該ピンを畳む（`question.asked` と対称に seq 境界は進めない）。
 */
export type QuestionClearedEvent = Envelope<"question.cleared"> & {
  /** クリア対象の `question.asked` の `id`。current?.id と一致するときだけピンを畳む。 */
  question_id: string;
};

export type SessionCompletedEvent = Envelope<"session.completed"> & {
  summary: {
    contradictions_resolved: number;
    gaps_found: number;
    issues_created: number;
  };
  artifacts: { kind: string; url: string }[];
};

/** agent → web の全イベント（契約 §3）。 */
export type ServerEvent =
  | StatusEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | DetectionContradictionEvent
  | DetectionGapEvent
  | DetectionAmbiguousEvent
  | DetectionResolvedEvent
  | RequirementUpsertedEvent
  | QuestionAskedEvent
  | QuestionClearedEvent
  | AnalysisProgressEvent
  | AnalysisVisualEvent
  | SessionCompletedEvent;

export type ServerEventType = ServerEvent["type"];

// ── §4.5 web → agent ───────────────────────────────────────────────────

export type UserSelectionEvent = Envelope<"user.selection"> & {
  detection_id: string;
  selected_value: string;
};

/** テキスト入力を会話ターンとして agent へ送る（契約 §4.5）。 */
export type UserTextEvent = Envelope<"user.text"> & {
  text: string;
};

/** 通常質問（金枠）への回答を agent へ送る（契約 §4.5）。 */
export type UserAnsweredEvent = Envelope<"user.answered"> & {
  question_id: string;
  /** 選択肢タップ時の値（自由記述で答えた場合は text を使う）。 */
  selected_value?: string;
  /** 自由記述での回答（任意）。 */
  text?: string;
};

/** web → agent の全イベント（契約 §4.5）。 */
export type ClientEvent = UserSelectionEvent | UserTextEvent | UserAnsweredEvent;
