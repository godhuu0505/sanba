
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

export interface Detection {
  id: string;
  kind: DetectionKind;
  summary: string;
  refs: string[];
  category?: string;
  options?: DetectionOption[];
  detector: string;
  resolved: boolean;
  resolution?: "user_selected" | "agent_resolved";
  selected_value?: string;
}

export interface AnalysisVisualConflict {
  summary: string;
  refs: string[];
}

export interface Question {
  id: string;
  prompt: string;
  options: DetectionOption[];
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

export type ContextProgressSource = "prep" | "repo";

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

export type QuestionAskedEvent = Envelope<"question.asked"> & {
  id: string;
  prompt: string;
  options?: DetectionOption[];
};

export type QuestionClearedEvent = Envelope<"question.cleared"> & {
  question_id: string;
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
  | DetectionContradictionEvent
  | DetectionGapEvent
  | DetectionAmbiguousEvent
  | DetectionResolvedEvent
  | RequirementUpsertedEvent
  | QuestionAskedEvent
  | QuestionClearedEvent
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

export type UserAnsweredEvent = Envelope<"user.answered"> & {
  question_id: string;
  selected_value?: string;
  text?: string;
};

export type ClientEvent = UserSelectionEvent | UserTextEvent | UserAnsweredEvent;
