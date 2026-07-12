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
  fetchInquiry,
  fetchRequirements,
} from "../api";
import { contractEventFixture } from "./fixtures";
import { RealtimeMetrics, type RealtimeMetricsSnapshot } from "./metrics";
import {
  decodeServerEvent,
  encodeUserInquiryDrop,
  encodeUserInterrupt,
  encodeUserMicMode,
  encodeUserSelection,
  encodeUserText,
  encodeUserTurnCommit,
  encodeUserTurnStart,
} from "./parse";
import { RealtimeStore, type SessionState } from "./store";
import { EVENTS_TOPIC, WEB_EVENTS_TOPIC, type ServerEvent } from "./types";

export type SendSelection = (detectionId: string, selectedValue: string) => void;

export type SendText = (text: string) => void;

export type SendInquiryDrop = (nodeId: string) => void;

export type SendInterrupt = () => void;

export type SendMicMode = (mode: "ptt" | "handsfree") => void;

export type SendTurnStart = () => void;

export type SendTurnCommit = () => void;

const GAP_HYDRATE_MIN_INTERVAL_MS = 2000;

export interface UseRealtimeSessionResult {
  state: SessionState;
  metrics: RealtimeMetricsSnapshot;
  store: RealtimeStore;
  sendSelection: SendSelection;
  sendText: SendText;
  sendInquiryDrop: SendInquiryDrop;
  sendInterrupt: SendInterrupt;
  sendMicMode: SendMicMode;
  sendTurnStart: SendTurnStart;
  sendTurnCommit: SendTurnCommit;
}

interface LiveOptions {
  sessionId: string;
  sessionToken: string | null;
  hydrateInquiry?: boolean;
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
  const { sessionId, sessionToken, hydrateInquiry, hydrateAnalysis } = opts;

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
  const sendInquiryDrop = useCallback<SendInquiryDrop>(
    (nodeId) => {
      clientSeq.current += 1;
      const payload = encodeUserInquiryDrop(
        sessionId,
        nodeId,
        clientSeq.current,
        new Date().toISOString(),
      );
      send(payload, { reliable: true });
    },
    [send, sessionId],
  );
  const sendInterrupt = useCallback<SendInterrupt>(() => {
    clientSeq.current += 1;
    const payload = encodeUserInterrupt(sessionId, clientSeq.current, new Date().toISOString());
    send(payload, { reliable: true });
  }, [send, sessionId]);
  const sendMicMode = useCallback<SendMicMode>(
    (mode) => {
      clientSeq.current += 1;
      const payload = encodeUserMicMode(
        sessionId,
        mode,
        clientSeq.current,
        new Date().toISOString(),
      );
      send(payload, { reliable: true });
    },
    [send, sessionId],
  );
  const sendTurnStart = useCallback<SendTurnStart>(() => {
    clientSeq.current += 1;
    const payload = encodeUserTurnStart(sessionId, clientSeq.current, new Date().toISOString());
    send(payload, { reliable: true });
  }, [send, sessionId]);
  const sendTurnCommit = useCallback<SendTurnCommit>(() => {
    clientSeq.current += 1;
    const payload = encodeUserTurnCommit(sessionId, clientSeq.current, new Date().toISOString());
    send(payload, { reliable: true });
  }, [send, sessionId]);

  const hydrateInFlightRef = useRef(false);
  const lastGapHydrateAtRef = useRef(0);

  const hydrate = useCallback(async () => {
    if (!sessionId) return;
    try {
      const snap = await fetchRequirements(sessionId, sessionToken);
      store.hydrateRequirements(snap.items, snap.seq);
    } catch {
    }
    if (hydrateInquiry) {
      try {
        const snap = await fetchInquiry(sessionId, sessionToken);
        store.hydrateInquiry(snap.nodes, snap.seq ?? 0);
      } catch {
      }
    }
    if (hydrateAnalysis) {
      try {
        const snap = await fetchContextFiles(sessionId, sessionToken);
        store.hydrateAnalysis(snap.items);
      } catch {
      }
    }
  }, [sessionId, sessionToken, hydrateInquiry, hydrateAnalysis, store]);

  const hydrateOnGap = useCallback(async () => {
    if (hydrateInFlightRef.current) return;
    const now = Date.now();
    if (now - lastGapHydrateAtRef.current < GAP_HYDRATE_MIN_INTERVAL_MS) return;
    lastGapHydrateAtRef.current = now;
    hydrateInFlightRef.current = true;
    try {
      await hydrate();
    } finally {
      hydrateInFlightRef.current = false;
    }
  }, [hydrate]);

  useEffect(() => {
    if (!sessionId) return;
    store.clear();
    store.setExpectedSessionId(sessionId);
    void hydrate();
    const off = store.onGapDetected(() => {
      store.metrics.recordReconnect();
      void hydrateOnGap();
    });
    return off;
  }, [sessionId, store, hydrate, hydrateOnGap]);

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

  return {
    state,
    metrics,
    store,
    sendSelection,
    sendText,
    sendInquiryDrop,
    sendInterrupt,
    sendMicMode,
    sendTurnStart,
    sendTurnCommit,
  };
}

const noopSelection: SendSelection = () => {};
const noopText: SendText = () => {};
const noopInquiryDrop: SendInquiryDrop = () => {};
const noopInterrupt: SendInterrupt = () => {};
const noopMicMode: SendMicMode = () => {};
const noopTurnStart: SendTurnStart = () => {};
const noopTurnCommit: SendTurnCommit = () => {};

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
    sendInquiryDrop: noopInquiryDrop,
    sendInterrupt: noopInterrupt,
    sendMicMode: noopMicMode,
    sendTurnStart: noopTurnStart,
    sendTurnCommit: noopTurnCommit,
  };
}
