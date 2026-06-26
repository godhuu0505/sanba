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

import { useConnectionState, useDataChannel } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { fetchDetections, fetchRequirements } from "../api";
import { contractEventFixture } from "./fixtures";
import { RealtimeMetrics, type RealtimeMetricsSnapshot } from "./metrics";
import {
  decodeServerEvent,
  encodeUserAnswered,
  encodeUserSelection,
  encodeUserText,
} from "./parse";
import { RealtimeStore, type SessionState } from "./store";
import { EVENTS_TOPIC, WEB_EVENTS_TOPIC, type ServerEvent } from "./types";

/** 検知カードの選択肢タップを agent へ送る（契約 §4.5 / Issue #102）。 */
export type SendSelection = (detectionId: string, selectedValue: string) => void;

/** テキスト入力を会話ターンとして agent へ送る（契約 §4.5 / #185）。 */
export type SendText = (text: string) => void;

/** 通常質問（金枠）への回答を agent へ送る（契約 §4.5 / #181）。 */
export type SendAnswer = (
  questionId: string,
  answer: { selectedValue?: string; text?: string },
) => void;

export interface UseRealtimeSessionResult {
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
  store: RealtimeStore;
  /** live モードのみ。fixture モードでは no-op。 */
  sendSelection: SendSelection;
  /** live モードのみ。fixture モードでは no-op。 */
  sendText: SendText;
  /** live モードのみ。fixture モードでは no-op。 */
  sendAnswer: SendAnswer;
}

interface LiveOptions {
  sessionId: string;
  /** join 済みトークン（JoinResponse.session_token）。GET の Bearer に使う。 */
  sessionToken: string | null;
  /** detections もハイドレーションする（08 の途中参加補強, 契約 §4 P1）。 */
  hydrateDetections?: boolean;
}

/** ストアと metrics を生成し、両方を React に購読させる土台。 */
function useStore(): {
  store: RealtimeStore;
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
} {
  const storeRef = useRef<RealtimeStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new RealtimeStore(new RealtimeMetrics());
  }
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // メトリクスも購読する。recordDropped/recordDuplicate のようにストア状態が変わらない
  // 更新でも観測値の変化として再描画される（不正/重複が UI に即反映される）。
  const metrics = useSyncExternalStore(
    store.metrics.subscribe,
    store.metrics.getSnapshot,
    store.metrics.getSnapshot,
  );
  return { store, state, metrics };
}

/**
 * 本番モード: データチャネル購読 + GET ハイドレーション。
 * LiveKitRoom コンテキスト内で呼ぶこと（useDataChannel の前提）。
 */
export function useRealtimeSession(opts: LiveOptions): UseRealtimeSessionResult {
  const { store, state, metrics } = useStore();
  const { sessionId, sessionToken, hydrateDetections } = opts;

  // 1) 購読を先行（契約 §4: 欠落防止のため GET より前に購読を張る）。
  const onMessage = useCallback(
    (msg: { payload: Uint8Array }) => {
      const { event } = decodeServerEvent(msg.payload);
      // session_id 照合・整列・冪等はストアが一括で担う（store.apply）。
      if (event) store.apply(event);
      else store.metrics.recordDropped();
    },
    [store],
  );
  useDataChannel(EVENTS_TOPIC, onMessage);

  // web → agent の送信チャネル（契約 §4.5）。逆方向 topic で混在を避ける。
  const { send } = useDataChannel(WEB_EVENTS_TOPIC);
  // web 発の単調増加 seq（agent 側 seq とは別空間）。selection/text/answered で共有する。
  const clientSeq = useRef(0);
  const sendSelection = useCallback<SendSelection>(
    (detectionId, selectedValue) => {
      clientSeq.current += 1;
      const payload = encodeUserSelection(
        sessionId,
        detectionId,
        selectedValue,
        clientSeq.current,
        new Date().toISOString(),
      );
      send(payload, { reliable: true });
    },
    [send, sessionId],
  );
  const sendText = useCallback<SendText>(
    (text) => {
      const trimmed = text.trim();
      if (!trimmed) return; // 空送信は無視（誤タップ・IME 確定前）。
      clientSeq.current += 1;
      const payload = encodeUserText(
        sessionId,
        trimmed,
        clientSeq.current,
        new Date().toISOString(),
      );
      send(payload, { reliable: true });
    },
    [send, sessionId],
  );
  const sendAnswer = useCallback<SendAnswer>(
    (questionId, answer) => {
      clientSeq.current += 1;
      const payload = encodeUserAnswered(
        sessionId,
        questionId,
        answer,
        clientSeq.current,
        new Date().toISOString(),
      );
      send(payload, { reliable: true });
    },
    [send, sessionId],
  );

  // 2) スナップショット取得 → seq 境界を確定。以後ライブ差分のみ適用される。
  //    欠番検知時にも同じ取得を再実行し、欠落分を復元する（契約 §4）。
  const hydrate = useCallback(async () => {
    if (!sessionId) return;
    try {
      const snap = await fetchRequirements(sessionId, sessionToken);
      store.hydrateRequirements(snap.items, snap.seq);
    } catch {
      // backend 未完/失敗でもライブ差分で前進できる（ハイドレーションは補助）。
    }
    if (hydrateDetections) {
      try {
        const snap = await fetchDetections(sessionId, sessionToken);
        store.hydrateDetections(snap.items, snap.seq ?? 0);
      } catch {
        /* P1・任意 */
      }
    }
  }, [sessionId, sessionToken, hydrateDetections, store]);

  useEffect(() => {
    if (!sessionId) return;
    // セッションが変わったら前セッションの状態を持ち越さない（混在防止）。
    store.clear();
    store.setExpectedSessionId(sessionId);
    void hydrate();
    // 欠番検知で再ハイドレーション（切断中に逃した差分を GET で取り直す）。
    const off = store.onGapDetected(() => {
      store.metrics.recordReconnect();
      void hydrate();
    });
    return off;
  }, [sessionId, store, hydrate]);

  // 再接続のたびにスナップショットを取り直す（Codex P2）。SessionView を保持したまま
  // 再接続する設計（03 / ConversationStart）では、切断中に他参加者/agent が更新し、
  // 復帰後に新しい seq イベントが来ないと画面が古いまま残るため、Connected 復帰時に
  // ローカル状態は保持したまま hydrate だけ再実行する（初回接続では二重実行しない）。
  const connState = useConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connState !== ConnectionState.Connected) return;
    if (wasConnected.current) {
      store.metrics.recordReconnect();
      void hydrate();
    }
    wasConnected.current = true;
  }, [connState, hydrate, store]);

  return { state, metrics, store, sendSelection, sendText, sendAnswer };
}

const noopSelection: SendSelection = () => {};
const noopText: SendText = () => {};
const noopAnswer: SendAnswer = () => {};

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

  return {
    state,
    metrics,
    store,
    sendSelection: noopSelection,
    sendText: noopText,
    sendAnswer: noopAnswer,
  };
}
