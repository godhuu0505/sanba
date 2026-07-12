
import { RealtimeMetrics } from "./metrics";
import type {
  AnalysisVisualConflict,
  ContextProgressSource,
  ContextProgressStage,
  InquiryNode,
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

export interface ContextProgressState {
  source: ContextProgressSource;
  stage: ContextProgressStage;
  label: string;
  detail: string;
}

export interface TranscriptLine {
  utterance_id: string;
  speaker: string;
  role: string;
  text: string;
  final: boolean;
}

export interface SessionCompletion {
  contradictions_resolved: number;
  gaps_found: number;
  issues_created: number;
  artifacts: { kind: string; url: string }[];
}

export interface EndProposal {
  open_count: number;
  requirement_count: number;
  material_count: number;
}

export interface SessionState {
  phase: SessionPhase;
  agentsActive: number;
  requirements: Requirement[];
  inquiryNodes: InquiryNode[];
  transcript: TranscriptLine[];
  analysis: AnalysisState[];
  contextProgress: ContextProgressState[];
  endProposal: EndProposal | null;
  completed: SessionCompletion | null;
  seq: number;
}

interface Versioned<T> {
  seq: number;
  value: T;
}

const emptySessionState = (): SessionState => ({
  phase: "idle",
  agentsActive: 0,
  requirements: [],
  inquiryNodes: [],
  transcript: [],
  analysis: [],
  contextProgress: [],
  endProposal: null,
  completed: null,
  seq: 0,
});

export class RealtimeStore {
  private requirements = new Map<string, Versioned<Requirement>>();
  private inquiryNodes = new Map<string, Versioned<InquiryNode>>();
  private transcript = new Map<string, Versioned<TranscriptLine>>();
  private analysis = new Map<string, Versioned<AnalysisState>>();
  private contextProgress = new Map<string, Versioned<ContextProgressState>>();
  private phase: SessionPhase = "idle";
  private agentsActive = 0;
  private endProposal: EndProposal | null = null;
  private lastEndProposedSeq = 0;
  private completed: SessionCompletion | null = null;

  private requirementsHydrationSeq = 0;
  private inquiryHydrationSeq = 0;
  private maxSeq = 0;
  private lastStatusSeq = 0;
  private lastStatusLossySeq = 0;
  private lastCompletedSeq = 0;
  private expectedSessionId: string | null = null;

  private cached: SessionState | null = null;
  private listeners = new Set<() => void>();
  private gapListeners = new Set<() => void>();

  constructor(readonly metrics: RealtimeMetrics = new RealtimeMetrics()) {}

  setExpectedSessionId(sessionId: string): void {
    this.expectedSessionId = sessionId;
  }

  onGapDetected(listener: () => void): () => void {
    this.gapListeners.add(listener);
    return () => this.gapListeners.delete(listener);
  }

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

  hydrateRequirements(items: Requirement[], seq: number): void {
    for (const r of items) {
      const prev = this.requirements.get(r.id);
      if (prev && prev.seq > seq) continue;
      this.requirements.set(r.id, { seq, value: r });
    }
    this.requirementsHydrationSeq = Math.max(this.requirementsHydrationSeq, seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  hydrateAnalysis(
    items: readonly { id: string; status: string; extracted_texts?: string[] }[],
  ): void {
    let changed = false;
    for (const f of items) {
      if (f.status !== "done" && f.status !== "failed") continue;
      if (this.analysis.has(f.id)) continue;
      this.analysis.set(f.id, {
        seq: 0,
        value: {
          asset_id: f.id,
          pct: 100,
          stage: f.status,
          extracted: f.extracted_texts ?? [],
          conflicts: [],
        },
      });
      changed = true;
    }
    if (changed) this.invalidate();
  }

  hydrateInquiry(nodes: InquiryNode[], seq: number): void {
    for (const n of nodes) {
      const prev = this.inquiryNodes.get(n.id);
      if (prev && prev.seq > seq) continue;
      this.inquiryNodes.set(n.id, { seq, value: n });
    }
    this.inquiryHydrationSeq = Math.max(this.inquiryHydrationSeq, seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  apply(event: ServerEvent): void {
    const startedAt = performance.now();

    if (this.expectedSessionId !== null && event.session_id !== this.expectedSessionId) {
      this.metrics.recordDropped();
      return;
    }

    const isLossy = event.reliable === false;

    if (!isLossy && event.seq <= this.snapshotBoundary(event.type)) {
      this.metrics.recordDuplicate();
      return;
    }

    if (!isLossy && this.maxSeq > 0 && event.seq > this.maxSeq + 1) {
      this.metrics.recordGap();
      for (const l of this.gapListeners) l();
    }

    const applied = this.reduce(event);
    if (!applied) {
      this.metrics.recordDuplicate();
      return;
    }

    if (!isLossy) this.maxSeq = Math.max(this.maxSeq, event.seq);
    this.metrics.recordReceived();
    this.metrics.recordApplyLatency(performance.now() - startedAt);
    this.invalidate();
  }

  private snapshotBoundary(type: ServerEvent["type"]): number {
    switch (type) {
      case "requirement.upserted":
        return this.requirementsHydrationSeq;
      case "inquiry.node":
        return this.inquiryHydrationSeq;
      default:
        return 0;
    }
  }

  private reduce(event: ServerEvent): boolean {
    switch (event.type) {
      case "status": {
        if (event.lossy_seq === undefined) {
          if (event.seq <= this.lastStatusSeq) return false;
          this.lastStatusSeq = event.seq;
        } else {
          if (event.lossy_seq <= this.lastStatusLossySeq) return false;
          this.lastStatusLossySeq = event.lossy_seq;
        }
        this.phase = event.phase;
        this.agentsActive = event.agents_active ?? 0;
        return true;
      }

      case "transcript.partial":
      case "transcript.final": {
        const isFinal = event.type === "transcript.final";
        const prev = this.transcript.get(event.utterance_id);
        if (prev?.value.final && !isFinal) return false;
        const version = isFinal ? event.seq : (event.lossy_seq ?? event.seq);
        if (prev && prev.value.final === isFinal && prev.seq >= version) return false;
        this.transcript.set(event.utterance_id, {
          seq: version,
          value: {
            utterance_id: event.utterance_id,
            speaker: event.speaker,
            role: event.role,
            text: event.text,
            final: isFinal,
          },
        });
        return true;
      }

      case "inquiry.node": {
        const status =
          event.op === "resolve"
            ? "resolved"
            : event.op === "drop"
              ? "dropped"
              : event.node.status;
        return this.upsert(this.inquiryNodes, event.node.id, event.seq, {
          ...event.node,
          status,
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
          pct: 100,
          stage: prev?.stage ?? "完了",
          extracted: event.extracted,
          conflicts: event.conflicts,
        });
      }

      case "context.progress":
        return this.upsert(this.contextProgress, event.source, event.seq, {
          source: event.source,
          stage: event.stage,
          label: event.label ?? "",
          detail: event.detail ?? "",
        });

      case "session.end_proposed":
        if (event.seq <= this.lastEndProposedSeq) return false;
        this.lastEndProposedSeq = event.seq;
        this.endProposal = {
          open_count: event.open_count,
          requirement_count: event.requirement_count,
          material_count: event.material_count,
        };
        return true;

      case "session.completed":
        if (event.seq <= this.lastCompletedSeq) return false;
        this.lastCompletedSeq = event.seq;
        this.completed = {
          contradictions_resolved: event.summary.contradictions_resolved,
          gaps_found: event.summary.gaps_found,
          issues_created: event.summary.issues_created,
          artifacts: event.artifacts,
        };
        return true;
    }
  }

  private upsert<T>(
    map: Map<string, Versioned<T>>,
    id: string,
    seq: number,
    value: T,
  ): boolean {
    const prev = map.get(id);
    if (prev && prev.seq >= seq) return false;
    map.set(id, { seq, value });
    return true;
  }

  private build(): SessionState {
    return {
      phase: this.phase,
      agentsActive: this.agentsActive,
      requirements: this.sortedValues(this.requirements),
      inquiryNodes: this.sortedInquiry(),
      transcript: this.sortedTranscript(),
      analysis: this.sortedValues(this.analysis),
      contextProgress: this.sortedValues(this.contextProgress),
      endProposal: this.endProposal,
      completed: this.completed,
      seq: this.maxSeq,
    };
  }

  private sortedValues<T>(map: Map<string, Versioned<T>>): T[] {
    return [...map.values()].sort((a, b) => a.seq - b.seq).map((v) => v.value);
  }

  private sortedInquiry(): InquiryNode[] {
    return [...this.inquiryNodes.values()]
      .map((v) => v.value)
      .sort((a, b) => a.created_seq - b.created_seq);
  }

  private sortedTranscript(): TranscriptLine[] {
    return [...this.transcript.values()]
      .sort((a, b) => {
        if (a.value.final !== b.value.final) return a.value.final ? -1 : 1;
        return a.seq - b.seq;
      })
      .map((v) => v.value);
  }

  clear(): void {
    this.requirements.clear();
    this.inquiryNodes.clear();
    this.transcript.clear();
    this.analysis.clear();
    this.contextProgress.clear();
    this.phase = "idle";
    this.agentsActive = 0;
    this.endProposal = null;
    this.lastEndProposedSeq = 0;
    this.completed = null;
    this.requirementsHydrationSeq = 0;
    this.inquiryHydrationSeq = 0;
    this.maxSeq = 0;
    this.lastStatusSeq = 0;
    this.lastStatusLossySeq = 0;
    this.lastCompletedSeq = 0;
    this.metrics.reset();
    this.invalidate();
  }
}

export { emptySessionState };
