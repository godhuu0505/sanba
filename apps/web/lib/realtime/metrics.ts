
export interface RealtimeMetricsSnapshot {
  received: number;
  duplicates: number;
  dropped: number;
  gaps: number;
  reconnects: number;
  lastApplyLatencyMs: number | null;
}

function emptySnapshot(): RealtimeMetricsSnapshot {
  return {
    received: 0,
    duplicates: 0,
    dropped: 0,
    gaps: 0,
    reconnects: 0,
    lastApplyLatencyMs: null,
  };
}

export class RealtimeMetrics {
  private snapshot = emptySnapshot();
  private cached: RealtimeMetricsSnapshot = this.snapshot;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RealtimeMetricsSnapshot => this.cached;

  private touch(): void {
    this.cached = { ...this.snapshot };
    for (const l of this.listeners) l();
  }

  recordReceived(): void {
    this.snapshot.received += 1;
    this.touch();
  }

  recordDuplicate(): void {
    this.snapshot.duplicates += 1;
    this.touch();
  }

  recordDropped(): void {
    this.snapshot.dropped += 1;
    this.touch();
  }

  recordGap(): void {
    this.snapshot.gaps += 1;
    this.touch();
  }

  recordReconnect(): void {
    this.snapshot.reconnects += 1;
    this.touch();
  }

  recordApplyLatency(ms: number): void {
    this.snapshot.lastApplyLatencyMs = ms;
    this.touch();
  }

  read(): RealtimeMetricsSnapshot {
    return this.cached;
  }

  reset(): void {
    this.snapshot = emptySnapshot();
    this.touch();
  }
}
