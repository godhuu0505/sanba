
export * from "./types";
export { decodeServerEvent, encodeUserSelection } from "./parse";
export {
  RealtimeStore,
  emptySessionState,
  type SessionState,
  type AnalysisState,
  type TranscriptLine,
  type SessionCompletion,
} from "./store";
export {
  RealtimeMetrics,
  type RealtimeMetricsSnapshot,
} from "./metrics";
export {
  useRealtimeSession,
  useFixtureSession,
  type UseRealtimeSessionResult,
  type SendSelection,
} from "./useRealtimeSession";
export {
  detectionPresentation,
  categoryPresentation,
  priorityLabel,
  PRIORITY_ORDER,
  type KindPresentation,
} from "./mapping";
export {
  selectOpenDetections,
  selectConfirmedRequirements,
  selectRequirementsByPriority,
  selectStats,
  type SessionStats,
} from "./selectors";
export { contractEventFixture, hydrationFixture } from "./fixtures";
