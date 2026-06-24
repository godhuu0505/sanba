// 受信基盤の観測性（CLAUDE.md 原則3 / 契約 §5）。
// 「観測できないものは運用できない」— 受信数・破棄・欠番・再接続・適用遅延を数える。
//
// React から購読できるよう useSyncExternalStore 互換の subscribe / getSnapshot を持つ。
// recordDropped() / recordDuplicate() のようにストア状態が変わらない更新でも、観測値の
// 変化として再描画されるようにする（不正 JSON・重複が UI のメトリクスに即反映される）。

export interface RealtimeMetricsSnapshot {
  /** デコードに成功し適用対象になった受信イベント数。 */
  received: number;
  /** seq ≤ 適用済み、または (type,id) 重複で適用しなかった件数。 */
  duplicates: number;
  /** デコード失敗（不正 JSON / エンベロープ / 未知種別 / 版不一致 / 別セッション）。 */
  dropped: number;
  /** seq の欠番（連続性が途切れた）を検知した回数。 */
  gaps: number;
  /** データチャネル再接続回数（再ハイドレーション契機）。 */
  reconnects: number;
  /** 受信〜ストア反映の遅延（ms）の直近値。観測対象（契約 §5）。 */
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

  /** useSyncExternalStore 用。変化が無ければ同一参照を返す（再レンダーループ防止）。 */
  getSnapshot = (): RealtimeMetricsSnapshot => this.cached;

  private touch(): void {
    // 不変スナップショットを作り直し、購読者へ通知する。
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
