// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";

const setMicrophoneEnabled = vi.fn();
vi.mock("@livekit/components-react", () => ({
  useRoomContext: () => ({ localParticipant: { setMicrophoneEnabled } }),
}));

import { usePushToTalk } from "./usePushToTalk";

function pointerEvent(overrides: Record<string, unknown> = {}) {
  return {
    pointerType: "touch",
    button: 0,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLElement>;
}

beforeEach(() => {
  setMicrophoneEnabled.mockReset();
  setMicrophoneEnabled.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("usePushToTalk（mode×pressed → mic enabled のゲーティング）", () => {
  it("既定はハンズフリーで mic を有効化する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    expect(result.current.mode).toBe("handsfree");
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
  });

  it("PTT へ切替えた瞬間に mute し、ハンズフリーへ戻すと再有効化する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    expect(result.current.mode).toBe("ptt");
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
  });

  it("押下開始で mic を有効化し interrupt を 1 回だけ送り、離すと mute する", async () => {
    const sendInterrupt = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt }));
    act(() => result.current.setMode("ptt"));

    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    expect(result.current.pttPressed).toBe(true);
    expect(sendInterrupt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));

    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    expect(sendInterrupt).toHaveBeenCalledTimes(1);

    act(() => result.current.pressProps.onPointerUp());
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("pointerleave でも確実に mute する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.pressProps.onPointerLeave());
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("pointercancel でも確実に mute する", () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.pressProps.onPointerCancel());
    expect(result.current.pttPressed).toBe(false);
  });

  it("マウスは主ボタン以外の押下を無視する", () => {
    const sendInterrupt = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt }));
    act(() => result.current.setMode("ptt"));
    act(() =>
      result.current.pressProps.onPointerDown(pointerEvent({ pointerType: "mouse", button: 2 })),
    );
    expect(result.current.pttPressed).toBe(false);
    expect(sendInterrupt).not.toHaveBeenCalled();
  });

  it("Space 長押しで押下し keyup で解除する（repeat は再送しない）", () => {
    const sendInterrupt = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt }));
    act(() => result.current.setMode("ptt"));

    fireEvent.keyDown(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(true);
    expect(sendInterrupt).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { code: "Space", repeat: true });
    expect(sendInterrupt).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
  });

  it("input フォーカス中の Space では押下しない", () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    input.remove();
  });

  it("ハンズフリー中は Space で押下しない", () => {
    const sendInterrupt = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt }));
    fireEvent.keyDown(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    expect(sendInterrupt).not.toHaveBeenCalled();
  });

  it("window blur で mute する（押しっぱなし漏れ防止）", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    fireEvent.blur(window);
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("押下中にハンズフリーへ切替えると押下状態を捨てて mic を有効化する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.setMode("handsfree"));
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
  });

  it("setMicrophoneEnabled の解決前に離しても最終状態は mute に収束する", async () => {
    const resolvers: Array<() => void> = [];
    setMicrophoneEnabled.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.pressProps.onPointerUp());

    await act(async () => {
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        if (resolve) resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    });

    expect(setMicrophoneEnabled.mock.calls.at(-1)?.[0]).toBe(false);
  });
});
