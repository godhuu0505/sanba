// 受信基盤の観測性（CLAUDE.md 原則3 / 契約 §5）。
// 「観測できないものは運用できない」— 受信数・破棄・欠番・再接続・適用遅延を数える。
//
// バックエンド非依存で動くよう、ここでは軽量なカウンタとして保持し、必要なら
// onFlush コールバックで OTel / ログ基盤へ転送する（送信先は環境側で差し替え可能）。

export interface RealtimeMetricsSnapshot {
  /** デコードに成功し適用対象になった受信イベント数。 */
  received: number;
  /** seq ≤ 適用済み、または (type,id) 重複で適用しなかった件数。 */
  duplicates: number;
  /** デコード失敗（不正 JSON / エンベロープ / 未知種別 / 版不一致）。 */
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

  constructor(private readonly onChange?: (s: RealtimeMetricsSnapshot) => void) {}

  private touch(): void {
    this.onChange?.(this.read());
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
    return { ...this.snapshot };
  }

  reset(): void {
    this.snapshot = emptySnapshot();
    this.touch();
  }
}
