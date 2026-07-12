"use client";

import { useRoomContext } from "@livekit/components-react";
import { ConnectionState, RoomEvent } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export type MicMode = "handsfree" | "ptt";

type PressSource = "pointer" | "key";

export interface PttPressProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

export interface UsePushToTalkOptions {
  sendTurnStart: () => void;
  sendTurnCommit: () => void;
  sendMicMode?: (mode: MicMode) => void;
  onError?: (message: string) => void;
  micEnabled?: boolean;
}

export interface UsePushToTalkResult {
  mode: MicMode;
  setMode: (mode: MicMode) => void;
  pttPressed: boolean;
  pressProps: PttPressProps;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.closest(
      "button, [role='button'], input, textarea, select, a[href], [contenteditable='true']",
    ) !== null
  );
}

export function usePushToTalk({
  sendTurnStart,
  sendTurnCommit,
  sendMicMode,
  onError,
  micEnabled,
}: UsePushToTalkOptions): UsePushToTalkResult {
  const room = useRoomContext();
  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  const [mode, setModeState] = useState<MicMode>("ptt");
  const [pttPressed, setPttPressed] = useState(false);
  const modeRef = useRef<MicMode>("ptt");
  const pressSourceRef = useRef<PressSource | null>(null);
  const restoreEnabledRef = useRef<boolean | null>(null);
  const sendTurnStartRef = useRef(sendTurnStart);
  const sendTurnCommitRef = useRef(sendTurnCommit);
  const sendMicModeRef = useRef(sendMicMode);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    sendTurnStartRef.current = sendTurnStart;
    sendTurnCommitRef.current = sendTurnCommit;
    sendMicModeRef.current = sendMicMode;
    onErrorRef.current = onError;
  }, [sendTurnStart, sendTurnCommit, sendMicMode, onError]);

  const desiredMicRef = useRef<boolean | null>(null);
  const applyingMicRef = useRef(false);

  const clearPressState = useCallback(() => {
    pressSourceRef.current = null;
    setPttPressed(false);
  }, []);

  const applyDesiredMic = useCallback(
    (want: boolean) => {
      desiredMicRef.current = want;
      if (applyingMicRef.current) return;
      applyingMicRef.current = true;
      void (async () => {
        try {
          for (;;) {
            const target = desiredMicRef.current;
            if (target === null) break;
            try {
              await roomRef.current.localParticipant.setMicrophoneEnabled(target);
            } catch (e) {
              console.error("ptt mic gate failed", e);
              onErrorRef.current?.(
                target
                  ? "マイクを開けませんでした。ブラウザのマイク許可を確認してください。"
                  : "マイクのミュートに失敗しました。",
              );
              if (target) clearPressState();
              if (desiredMicRef.current === target) break;
              continue;
            }
            if (desiredMicRef.current === target) break;
          }
        } finally {
          applyingMicRef.current = false;
        }
      })();
    },
    [clearPressState],
  );

  const startPress = useCallback(
    (source: PressSource) => {
      if (modeRef.current !== "ptt") return;
      if (pressSourceRef.current !== null) return;
      pressSourceRef.current = source;
      setPttPressed(true);
      sendTurnStartRef.current();
      applyDesiredMic(true);
    },
    [applyDesiredMic],
  );

  const endPress = useCallback(
    (source?: PressSource) => {
      if (pressSourceRef.current === null) return;
      if (source !== undefined && pressSourceRef.current !== source) return;
      clearPressState();
      if (modeRef.current === "ptt") {
        sendTurnCommitRef.current();
        applyDesiredMic(false);
      }
    },
    [applyDesiredMic, clearPressState],
  );

  const setMode = useCallback(
    (next: MicMode) => {
      const prev = modeRef.current;
      if (next === prev) return;
      modeRef.current = next;
      clearPressState();
      setModeState(next);
      sendMicModeRef.current?.(next);
      if (next === "ptt") {
        restoreEnabledRef.current = roomRef.current.localParticipant.isMicrophoneEnabled;
        applyDesiredMic(false);
        return;
      }
      const restore = restoreEnabledRef.current;
      restoreEnabledRef.current = null;
      applyDesiredMic(restore ?? true);
    },
    [applyDesiredMic, clearPressState],
  );

  useEffect(() => {
    if (modeRef.current === "ptt") applyDesiredMic(false);
  }, [applyDesiredMic]);

  useEffect(() => {
    const r = room;
    const announce = () => sendMicModeRef.current?.(modeRef.current);
    if (r.state === ConnectionState.Connected) announce();
    r.on(RoomEvent.Connected, announce);
    return () => {
      r.off(RoomEvent.Connected, announce);
    };
  }, [room]);

  useEffect(() => {
    if (micEnabled !== true) return;
    if (modeRef.current !== "ptt" || pressSourceRef.current !== null) return;
    applyDesiredMic(false);
  }, [micEnabled, applyDesiredMic]);

  useEffect(
    () => () => {
      const restore = restoreEnabledRef.current;
      restoreEnabledRef.current = null;
      const target = pressSourceRef.current !== null ? false : restore;
      if (target !== null) {
        roomRef.current.localParticipant.setMicrophoneEnabled(target).catch((e: unknown) => {
          console.error("ptt mic restore failed", e);
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (mode !== "ptt") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (isInteractiveTarget(e.target)) return;
      e.preventDefault();
      startPress("key");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      endPress("key");
    };
    const onBlur = () => endPress();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      endPress();
    };
  }, [mode, startPress, endPress]);

  const pressProps = useMemo<PttPressProps>(
    () => ({
      onPointerDown: (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        startPress("pointer");
      },
      onPointerUp: () => endPress("pointer"),
      onPointerLeave: () => endPress("pointer"),
      onPointerCancel: () => endPress("pointer"),
      onLostPointerCapture: () => endPress("pointer"),
      onContextMenu: (e) => e.preventDefault(),
    }),
    [startPress, endPress],
  );

  return { mode, setMode, pttPressed, pressProps };
}
