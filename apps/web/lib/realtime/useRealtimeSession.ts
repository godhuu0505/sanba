"use client";


import { useConnectionState, useDataChannel } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  fetchContextFiles,
  fetchCurrentQuestion,
  fetchDetections,
  fetchRequirements,
} from "../api";
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

export type SendSelection = (detectionId: string, selectedValue: string) => void;

export type SendText = (text: string) => void;

export type SendAnswer = (
  questionId: string,
  answer: { selectedValue?: string; text?: string },
) => void;

export interface UseRealtimeSessionResult {
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
  store: RealtimeStore;
  sendSelection: SendSelection;
  sendText: SendText;
  sendAnswer: SendAnswer;
}

interface LiveOptions {
  sessionId: string;
  sessionToken: string | null;
  hydrateDetections?: boolean;
  hydrateAnalysis?: boolean;
}

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
  const metrics = useSyncExternalStore(
    store.metrics.subscribe,
    store.metrics.getSnapshot,
    store.metrics.getSnapshot,
  );
  return { store, state, metrics };
}

export function useRealtimeSession(opts: LiveOptions): UseRealtimeSessionResult {
  const { store, state, metrics } = useStore();
  const { sessionId, sessionToken, hydrateDetections, hydrateAnalysis } = opts;

  const onMessage = useCallback(
    (msg: { payload: Uint8Array }) => {
      const { event } = decodeServerEvent(msg.payload);
      if (event) store.apply(event);
      else store.metrics.recordDropped();
    },
    [store],
  );
  useDataChannel(EVENTS_TOPIC, onMessage);

  const { send } = useDataChannel(WEB_EVENTS_TOPIC);
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
      if (!trimmed) return;
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

  const hydrate = useCallback(async () => {
    if (!sessionId) return;
    let requirementsOk = false;
    let detectionsOk = !hydrateDetections;
    try {
      const snap = await fetchRequirements(sessionId, sessionToken);
      store.hydrateRequirements(snap.items, snap.seq);
      requirementsOk = true;
    } catch {
    }
    if (hydrateDetections) {
      try {
        const snap = await fetchDetections(sessionId, sessionToken);
        store.hydrateDetections(snap.items, snap.seq ?? 0);
        detectionsOk = true;
      } catch {
      }
    }
    try {
      const snap = await fetchCurrentQuestion(sessionId, sessionToken);
      store.hydrateQuestion(snap.question, snap.seq, requirementsOk && detectionsOk);
    } catch {
    }
    if (hydrateAnalysis) {
      try {
        const snap = await fetchContextFiles(sessionId, sessionToken);
        store.hydrateAnalysis(snap.items);
      } catch {
      }
    }
  }, [sessionId, sessionToken, hydrateDetections, hydrateAnalysis, store]);

  useEffect(() => {
    if (!sessionId) return;
    store.clear();
    store.setExpectedSessionId(sessionId);
    void hydrate();
    const off = store.onGapDetected(() => {
      store.metrics.recordReconnect();
      void hydrate();
    });
    return off;
  }, [sessionId, store, hydrate]);

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

export function useFixtureSession(
  events: ServerEvent[] = contractEventFixture,
  opts: { stepMs?: number } = {},
): UseRealtimeSessionResult {
  const { store, state, metrics } = useStore();
  const stepMs = opts.stepMs ?? 600;
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
