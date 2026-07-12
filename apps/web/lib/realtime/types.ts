
export const SCHEMA_VERSION = 1 as const;

export const EVENTS_TOPIC = "sanba.events";
export const WEB_EVENTS_TOPIC = "sanba.events.web";


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
  kind: string;
  ref: string;
}

export interface Requirement {
  id: string;
  statement: string;
  category: RequirementCategory;
  priority: Priority;
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

export type InquiryKind = "gap" | "contradiction" | "ambiguous" | "check";

export type InquiryStatus = "open" | "resolved" | "dropped";

export type InquiryOp = "upsert" | "resolve" | "drop";

export interface InquiryNode {
  id: string;
  parent_id: string | null;
  kind: InquiryKind;
  text: string;
  status: InquiryStatus;
  confidence: number;
  depth: number;
  origin: string;
  refs: string[];
  created_seq: number;
  resolved_seq: number | null;
}

export interface AnalysisVisualConflict {
  summary: string;
  refs: string[];
}


interface Envelope<T extends string> {
  v: number;
  type: T;
  seq: number;
  reliable?: boolean;
  lossy_seq?: number;
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

export type InquiryNodeEvent = Envelope<"inquiry.node"> & {
  op: InquiryOp;
  node: InquiryNode;
};

export type RequirementUpsertedEvent = Envelope<"requirement.upserted"> & {
  requirement: Requirement;
};

export type AnalysisProgressEvent = Envelope<"analysis.progress"> & {
  asset_id: string;
  pct: number;
  stage: string;
};

export type ContextProgressSource = "prep" | "repo" | "materials";

export type ContextProgressStage = "running" | "done" | "reused" | "partial" | "failed";

export type ContextProgressEvent = Envelope<"context.progress"> & {
  source: ContextProgressSource;
  stage: ContextProgressStage;
  label?: string;
  detail?: string;
};

export type AnalysisVisualEvent = Envelope<"analysis.visual"> & {
  asset_id: string;
  extracted: string[];
  conflicts: AnalysisVisualConflict[];
};

export type SessionEndProposedEvent = Envelope<"session.end_proposed"> & {
  open_count: number;
  requirement_count: number;
  material_count: number;
};

export type SessionCompletedEvent = Envelope<"session.completed"> & {
  summary: {
    contradictions_resolved: number;
    gaps_found: number;
    issues_created: number;
  };
  artifacts: { kind: string; url: string }[];
};

export type ServerEvent =
  | StatusEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | InquiryNodeEvent
  | RequirementUpsertedEvent
  | AnalysisProgressEvent
  | AnalysisVisualEvent
  | ContextProgressEvent
  | SessionEndProposedEvent
  | SessionCompletedEvent;

export type ServerEventType = ServerEvent["type"];


export type UserSelectionEvent = Envelope<"user.selection"> & {
  detection_id: string;
  selected_value: string;
};

export type UserTextEvent = Envelope<"user.text"> & {
  text: string;
};

export type UserInquiryDropEvent = Envelope<"user.inquiry_drop"> & {
  node_id: string;
};

export type UserInterruptEvent = Envelope<"user.interrupt">;

export type ClientEvent =
  | UserSelectionEvent
  | UserTextEvent
  | UserInquiryDropEvent
  | UserInterruptEvent;
