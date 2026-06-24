"use client";

// 共有 realtime セッション hook（Issue #101）。
//
// 3画面（05/08/09）はこの hook の公開 API（state / metrics / store）を消費するだけにする。
// 購読層・整列・冪等・ハイドレーションはここに一本化し、画面側に購読コードを書かせない
// （衝突回避ルール: apps/web の購読層・イベントストアは #101 に一本化）。
//
// 動作モード:
//   - live  : LiveKit データチャネル（topic="sanba.events"）を購読 + GET ハイドレーション
//   - fixture: backend 非依存で契約フィクスチャを再生（静的 UI 先行着手用）

import { useDataChannel } from "@livekit/components-react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { fetchDetections, fetchRequirements } from "../api";
import { contractEventFixture } from "./fixtures";
import { RealtimeMetrics, type RealtimeMetricsSnapshot } from "./metrics";
import { decodeServerEvent } from "./parse";
import { RealtimeStore, type SessionState } from "./store";
import { EVENTS_TOPIC, type ServerEvent } from "./types";

export interface UseRealtimeSessionResult {
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
  store: RealtimeStore;
}

interface LiveOptions {
  sessionId: string;
  /** 認可トークン（Bearer）。dev モードでは null 可。 */
  idToken: string | null;
  /** detections もハイドレーションする（08 の途中参加補強, 契約 §4 P1）。 */
  hydrateDetections?: boolean;
}

/** ストアと metrics を生成し、React に購読させる土台。 */
function useStore(): {
  store: RealtimeStore;
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
} {
  // metrics は変更通知でストアを invalidate しないよう、独立の購読を持つ。
  const metricsRef = useRef<RealtimeMetrics | null>(null);
  const storeRef = useRef<RealtimeStore | null>(null);
  if (storeRef.current === null) {
    const metrics = new RealtimeMetrics();
    metricsRef.current = metrics;
    storeRef.current = new RealtimeStore(metrics);
  }
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const metrics = store.metrics.read();
  return { store, state, metrics };
}

/**
 * 本番モード: データチャネル購読 + GET ハイドレーション。
 * LiveKitRoom コンテキスト内で呼ぶこと（useDataChannel の前提）。
 */
export function useRealtimeSession(opts: LiveOptions): UseRealtimeSessionResult {
  const { store, state, metrics } = useStore();
  const { sessionId, idToken, hydrateDetections } = opts;

  // 1) 購読を先行（契約 §4: 欠落防止のため GET より前に購読を張る）。
  const onMessage = useCallback(
    (msg: { payload: Uint8Array }) => {
      const { event } = decodeServerEvent(msg.payload);
      if (event) store.apply(event);
      else store.metrics.recordDropped();
    },
    [store],
  );
  useDataChannel(EVENTS_TOPIC, onMessage);

  // 2) スナップショット取得 → seq 境界を確定。以後ライブ差分のみ適用される。
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await fetchRequirements(sessionId, idToken);
        if (!cancelled) store.hydrateRequirements(snap.items, snap.seq);
      } catch {
        // backend 未完/失敗でもライブ差分で前進できる（ハイドレーションは補助）。
      }
      if (hydrateDetections) {
        try {
          const snap = await fetchDetections(sessionId, idToken);
          if (!cancelled) store.hydrateDetections(snap.items, snap.seq ?? 0);
        } catch {
          /* P1・任意 */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, idToken, hydrateDetections, store]);

  return { state, metrics, store };
}

/**
 * フィクスチャモード: backend 非依存で契約イベント列を再生する。
 * 3画面の静的 UI を本接続前に組むための土台（フロント先行着手の鍵）。
 */
export function useFixtureSession(
  events: ServerEvent[] = contractEventFixture,
  opts: { stepMs?: number } = {},
): UseRealtimeSessionResult {
  const { store, state, metrics } = useStore();
  const stepMs = opts.stepMs ?? 600;
  // events 配列の同一性に依存して再生を 1 回だけ走らせる。
  const stable = useMemo(() => events, [events]);

  useEffect(() => {
    store.clear();
    let i = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const e of stable) {
      timers.push(setTimeout(() => store.apply(e), stepMs * i));
      i += 1;
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [stable, stepMs, store]);

  return { state, metrics, store };
}
