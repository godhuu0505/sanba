// 共有 realtime イベントストア（Epic #93 / Issue #101）。
//
// 3つの P0 画面（05 検知 / 08 解析 / 09 要件絵巻）が共通で必要とする受信状態を
// 1か所に集約する。各画面で別々に購読層を書くと 3重複・マージ衝突するため、ここで
// 共有化する（並列化の要）。
//
// 契約（docs/design/realtime-contract.md §2）の適用規則:
//   - `(type, id)` で冪等（同じ要件/検知は upsert）
//   - `seq` で順序を担保（単調増加・整列）
//   - 同一 seq の再配信は重複排除、欠番は検知して再ハイドレーションの契機にする
//
// フレームワーク非依存（React 非依存）にして単体テスト可能にし、UI へは
// useSyncExternalStore 互換の subscribe / getSnapshot で公開する。

import { RealtimeMetrics } from "./metrics";
import type {
  AnalysisVisualConflict,
  Detection,
  Requirement,
  ServerEvent,
  SessionPhase,
} from "./types";

export interface AnalysisState {
  asset_id: string;
  pct: number;
  stage: string;
  extracted: string[];
  conflicts: AnalysisVisualConflict[];
}

export interface TranscriptLine {
  utterance_id: string;
  speaker: string;
  role: string;
  text: string;
  /** 確定済みか（false は認識中の partial）。 */
  final: boolean;
}

export interface SessionCompletion {
  contradictions_resolved: number;
  gaps_found: number;
  issues_created: number;
  artifacts: { kind: string; url: string }[];
}

/** UI に公開する不変スナップショット。参照が変わったときだけ再描画される。 */
export interface SessionState {
  phase: SessionPhase;
  agentsActive: number;
  /** 確定/下書き要件。受信順（seq 昇順）。 */
  requirements: Requirement[];
  /** 検知（矛盾/抜け）。seq 昇順。UI ではスタックの最新を前面にする。 */
  detections: Detection[];
  /** 確定発話 + 認識中 partial。utterance_id 単位。 */
  transcript: TranscriptLine[];
  /** 素材 asset_id ごとの解析状態。 */
  analysis: AnalysisState[];
  completed: SessionCompletion | null;
  /** 適用済みの最大 seq（ハイドレーション境界の判定に使う）。 */
  seq: number;
}

interface Versioned<T> {
  seq: number;
  value: T;
}

const EMPTY_STATE: SessionState = {
  phase: "idle",
  agentsActive: 0,
  requirements: [],
  detections: [],
  transcript: [],
  analysis: [],
  completed: null,
  seq: 0,
};

export class RealtimeStore {
  private requirements = new Map<string, Versioned<Requirement>>();
  private detections = new Map<string, Versioned<Detection>>();
  private transcript = new Map<string, Versioned<TranscriptLine>>();
  private analysis = new Map<string, Versioned<AnalysisState>>();
  private phase: SessionPhase = "idle";
  private agentsActive = 0;
  private completed: SessionCompletion | null = null;

  /** ハイドレーションのスナップショット境界 seq。これ以下のライブイベントは破棄。 */
  private hydrationSeq = 0;
  /** 観測した最大 seq（欠番検知用）。 */
  private maxSeq = 0;

  private cached: SessionState | null = null;
  private listeners = new Set<() => void>();

  constructor(readonly metrics: RealtimeMetrics = new RealtimeMetrics()) {}

  // ── React 連携（useSyncExternalStore） ─────────────────────────────
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState => {
    if (this.cached === null) this.cached = this.build();
    return this.cached;
  };

  private invalidate(): void {
    this.cached = null;
    for (const l of this.listeners) l();
  }

  // ── ハイドレーション（契約 §4） ────────────────────────────────────
  /**
   * GET /requirements のスナップショットを取り込み、境界 seq を確定する。
   * これ以降は seq > hydrationSeq のライブ差分だけを適用する（空白・重複ゼロ）。
   */
  hydrateRequirements(items: Requirement[], seq: number): void {
    for (const r of items) {
      const prev = this.requirements.get(r.id);
      // スナップショットより新しいライブ差分が先着していたら上書きしない。
      if (prev && prev.seq > seq) continue;
      this.requirements.set(r.id, { seq, value: r });
    }
    this.hydrationSeq = Math.max(this.hydrationSeq, seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  /** GET /detections?open=1 の未解消検知を取り込む（契約 §4 P1）。 */
  hydrateDetections(items: Detection[], seq: number): void {
    for (const d of items) {
      const prev = this.detections.get(d.id);
      if (prev && prev.seq > seq) continue;
      this.detections.set(d.id, { seq, value: d });
    }
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  // ── ライブイベント適用 ─────────────────────────────────────────────
  /** 1 件のサーバイベントを適用する。冪等・整列・欠番検知を行う。 */
  apply(event: ServerEvent): void {
    const startedAt = performance.now();

    // ハイドレーション境界より古いライブ差分はスナップショットに含まれる → 破棄。
    if (event.seq <= this.hydrationSeq) {
      this.metrics.recordDuplicate();
      return;
    }

    // 欠番検知: 期待する次 seq を飛ばして届いたら gap（再ハイドレーション契機）。
    if (this.maxSeq > 0 && event.seq > this.maxSeq + 1) {
      this.metrics.recordGap();
    }

    const applied = this.reduce(event);
    if (!applied) {
      this.metrics.recordDuplicate();
      return;
    }

    this.maxSeq = Math.max(this.maxSeq, event.seq);
    this.metrics.recordReceived();
    this.metrics.recordApplyLatency(performance.now() - startedAt);
    this.invalidate();
  }

  /** 適用したら true、（古い/重複で）スキップしたら false。 */
  private reduce(event: ServerEvent): boolean {
    switch (event.type) {
      case "status":
        this.phase = event.phase;
        this.agentsActive = event.agents_active ?? 0;
        return true;

      case "transcript.partial":
      case "transcript.final": {
        const final = event.type === "transcript.final";
        return this.upsert(this.transcript, event.utterance_id, event.seq, {
          utterance_id: event.utterance_id,
          speaker: event.speaker,
          role: event.role,
          text: event.text,
          final,
        });
      }

      case "detection.contradiction":
        return this.upsert(this.detections, event.id, event.seq, {
          id: event.id,
          kind: "contradiction",
          summary: event.summary,
          refs: event.refs,
          options: event.options,
          detector: event.detector,
          resolved: false,
        });

      case "detection.gap":
        return this.upsert(this.detections, event.id, event.seq, {
          id: event.id,
          kind: "gap",
          summary: event.summary,
          category: event.category,
          refs: event.refs,
          detector: event.detector,
          resolved: false,
        });

      case "detection.resolved": {
        const prev = this.detections.get(event.detection_id);
        if (!prev) {
          // 対象未着でも解消だけ先に来る場合があるため、最小の解消マーカを置く。
          return this.upsert(this.detections, event.detection_id, event.seq, {
            id: event.detection_id,
            kind: "contradiction",
            summary: "",
            refs: [],
            detector: "",
            resolved: true,
            resolution: event.resolution,
            selected_value: event.selected_value,
          });
        }
        return this.upsert(this.detections, event.detection_id, event.seq, {
          ...prev.value,
          resolved: true,
          resolution: event.resolution,
          selected_value: event.selected_value ?? prev.value.selected_value,
        });
      }

      case "requirement.upserted":
        return this.upsert(
          this.requirements,
          event.requirement.id,
          event.seq,
          event.requirement,
        );

      case "analysis.progress": {
        const prev = this.analysis.get(event.asset_id)?.value;
        return this.upsert(this.analysis, event.asset_id, event.seq, {
          asset_id: event.asset_id,
          pct: event.pct,
          stage: event.stage,
          extracted: prev?.extracted ?? [],
          conflicts: prev?.conflicts ?? [],
        });
      }

      case "analysis.visual": {
        const prev = this.analysis.get(event.asset_id)?.value;
        return this.upsert(this.analysis, event.asset_id, event.seq, {
          asset_id: event.asset_id,
          pct: prev?.pct ?? 100,
          stage: prev?.stage ?? "完了",
          extracted: event.extracted,
          conflicts: event.conflicts,
        });
      }

      case "session.completed":
        this.completed = {
          contradictions_resolved: event.summary.contradictions_resolved,
          gaps_found: event.summary.gaps_found,
          issues_created: event.summary.issues_created,
          artifacts: event.artifacts,
        };
        return true;
    }
  }

  /**
   * (type,id) 冪等 upsert。既存の方が新しい seq なら（再配信/順序逆転）スキップ。
   * 反映したら true。
   */
  private upsert<T>(
    map: Map<string, Versioned<T>>,
    id: string,
    seq: number,
    value: T,
  ): boolean {
    const prev = map.get(id);
    if (prev && prev.seq >= seq) return false; // 既存が同等以上に新しい → 重複/逆順
    map.set(id, { seq, value });
    return true;
  }

  // ── スナップショット構築 ───────────────────────────────────────────
  private build(): SessionState {
    return {
      phase: this.phase,
      agentsActive: this.agentsActive,
      requirements: this.sortedValues(this.requirements),
      detections: this.sortedValues(this.detections),
      transcript: this.sortedValues(this.transcript),
      analysis: this.sortedValues(this.analysis),
      completed: this.completed,
      seq: this.maxSeq,
    };
  }

  private sortedValues<T>(map: Map<string, Versioned<T>>): T[] {
    return [...map.values()].sort((a, b) => a.seq - b.seq).map((v) => v.value);
  }

  /** テスト/リセット用。 */
  clear(): void {
    this.requirements.clear();
    this.detections.clear();
    this.transcript.clear();
    this.analysis.clear();
    this.phase = "idle";
    this.agentsActive = 0;
    this.completed = null;
    this.hydrationSeq = 0;
    this.maxSeq = 0;
    this.metrics.reset();
    this.invalidate();
  }
}

export const emptySessionState = (): SessionState => EMPTY_STATE;
