// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";

const participant = {
  isMicrophoneEnabled: true,
  setMicrophoneEnabled: vi.fn(),
};
vi.mock("@livekit/components-react", () => ({
  useRoomContext: () => ({ localParticipant: participant }),
}));

import { usePushToTalk } from "./usePushToTalk";

const setMicrophoneEnabled = participant.setMicrophoneEnabled;

function pointerEvent(overrides: Record<string, unknown> = {}) {
  return {
    pointerType: "touch",
    button: 0,
    pointerId: 1,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLElement>;
}

beforeEach(() => {
  participant.isMicrophoneEnabled = true;
  setMicrophoneEnabled.mockReset();
  setMicrophoneEnabled.mockImplementation(async (enabled: boolean) => {
    participant.isMicrophoneEnabled = enabled;
  });
});

afterEach(() => cleanup());

describe("usePushToTalk（mode×pressed → mic enabled のゲーティング）", () => {
  it("既定のハンズフリーでは mic に触らない（既存のミュート操作と競合しない）", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    expect(result.current.mode).toBe("handsfree");
    expect(result.current.pttPressed).toBe(false);
    await act(async () => {});
    expect(setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("PTT へ切替えた瞬間に mute し、ハンズフリーへ戻すと切替前の状態を復元する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
  });

  it("手動ミュート中に PTT を往復してもミュートが解除されない", async () => {
    participant.isMicrophoneEnabled = false;
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    expect(setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
  });

  it("押下開始で mic を有効化・capture を取り・interrupt を 1 回だけ送り、離すと mute する", async () => {
    const sendInterrupt = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt }));
    act(() => result.current.setMode("ptt"));

    const down = pointerEvent();
    act(() => result.current.pressProps.onPointerDown(down));
    expect(result.current.pttPressed).toBe(true);
    expect(sendInterrupt).toHaveBeenCalledTimes(1);
    expect(
      (down.currentTarget as unknown as { setPointerCapture: ReturnType<typeof vi.fn> })
        .setPointerCapture,
    ).toHaveBeenCalledWith(1);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));

    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    expect(sendInterrupt).toHaveBeenCalledTimes(1);

    act(() => result.current.pressProps.onPointerUp());
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("pointerleave / pointercancel / lostpointercapture でも確実に mute する", () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    for (const end of ["onPointerLeave", "onPointerCancel", "onLostPointerCapture"] as const) {
      act(() => result.current.pressProps.onPointerDown(pointerEvent()));
      expect(result.current.pttPressed).toBe(true);
      act(() => result.current.pressProps[end]());
      expect(result.current.pttPressed).toBe(false);
    }
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

  it("button フォーカス中の Space では押下しない（Space によるボタン活性化を奪わない）", () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    const button = document.createElement("button");
    document.body.appendChild(button);
    fireEvent.keyDown(button, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    button.remove();
  });

  it("ポインタ押下中は input での Space keyup で解除されない（起点別に解除）", () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyUp(input, { code: "Space" });
    expect(result.current.pttPressed).toBe(true);
    act(() => result.current.pressProps.onPointerUp());
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

  it("押下中にハンズフリーへ切替えると押下状態を捨てて切替前の状態を復元する", async () => {
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.setMode("handsfree"));
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
  });

  it("PTT モード中のアンマウントで切替前の状態を復元する", async () => {
    const { result, unmount } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn() }));
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    unmount();
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

  it("mic を開けなかったら onError を呼び、押下状態を解除する", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => usePushToTalk({ sendInterrupt: vi.fn(), onError }));
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));

    setMicrophoneEnabled.mockRejectedValueOnce(new Error("permission denied"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pttPressed).toBe(false));
  });
});
