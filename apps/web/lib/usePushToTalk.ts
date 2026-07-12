"use client";

import { useRoomContext } from "@livekit/components-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export type MicMode = "handsfree" | "ptt";

export interface PttPressProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

export interface UsePushToTalkOptions {
  sendInterrupt: () => void;
}

export interface UsePushToTalkResult {
  mode: MicMode;
  setMode: (mode: MicMode) => void;
  pttPressed: boolean;
  pressProps: PttPressProps;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function usePushToTalk({ sendInterrupt }: UsePushToTalkOptions): UsePushToTalkResult {
  const room = useRoomContext();
  const [mode, setModeState] = useState<MicMode>("handsfree");
  const [pttPressed, setPttPressed] = useState(false);
  const pressedRef = useRef(false);

  const startPress = useCallback(() => {
    if (pressedRef.current) return;
    pressedRef.current = true;
    setPttPressed(true);
    sendInterrupt();
  }, [sendInterrupt]);

  const endPress = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPttPressed(false);
  }, []);

  const setMode = useCallback((next: MicMode) => {
    pressedRef.current = false;
    setPttPressed(false);
    setModeState(next);
  }, []);

  const micEnabled = mode === "handsfree" || pttPressed;

  const desiredMicRef = useRef(micEnabled);
  const applyingMicRef = useRef(false);
  const applyMic = useCallback(async () => {
    if (applyingMicRef.current) return;
    applyingMicRef.current = true;
    try {
      let want = desiredMicRef.current;
      for (;;) {
        await room.localParticipant.setMicrophoneEnabled(want);
        if (desiredMicRef.current === want) break;
        want = desiredMicRef.current;
      }
    } catch (e) {
      console.error("ptt mic gate failed", e);
    } finally {
      applyingMicRef.current = false;
    }
  }, [room]);

  useEffect(() => {
    desiredMicRef.current = micEnabled;
    void applyMic();
  }, [micEnabled, applyMic]);

  useEffect(() => {
    if (mode !== "ptt") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
      startPress();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      endPress();
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
        startPress();
      },
      onPointerUp: endPress,
      onPointerLeave: endPress,
      onPointerCancel: endPress,
      onContextMenu: (e) => e.preventDefault(),
    }),
    [startPress, endPress],
  );

  return { mode, setMode, pttPressed, pressProps };
}
