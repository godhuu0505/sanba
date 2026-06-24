// 共有 realtime 受信基盤の公開 API（Issue #101 / Epic #93）。
//
// 3画面（05 検知 / 08 解析 / 09 要件絵巻）はここからだけ import する。購読層・ストア・
// ハイドレーション・マッピングはこのモジュールに一本化されている（衝突回避ルール）。

export * from "./types";
export { decodeServerEvent } from "./parse";
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
