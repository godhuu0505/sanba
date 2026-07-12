// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerEvent as ReactPointerEvent } from "react";

const participant = {
  isMicrophoneEnabled: true,
  setMicrophoneEnabled: vi.fn(),
};
const room = {
  localParticipant: participant,
  state: "connected",
  on: vi.fn(),
  off: vi.fn(),
};
vi.mock("@livekit/components-react", () => ({
  useRoomContext: () => room,
}));

import { type UsePushToTalkOptions, usePushToTalk } from "./usePushToTalk";

const setMicrophoneEnabled = participant.setMicrophoneEnabled;

function opts(over: Partial<UsePushToTalkOptions> = {}): UsePushToTalkOptions {
  return { sendTurnStart: vi.fn(), sendTurnCommit: vi.fn(), ...over };
}

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
  it("既定は PTT で、マウント時に mic を mute する", async () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    expect(result.current.mode).toBe("ptt");
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("接続後に外部要因で mic が有効化されても、PTT 待機中は mute へ戻す", async () => {
    const { rerender } = renderHook(
      (props: { micEnabled: boolean }) => usePushToTalk(opts({ micEnabled: props.micEnabled })),
      { initialProps: { micEnabled: false } },
    );
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    setMicrophoneEnabled.mockClear();
    rerender({ micEnabled: true });
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("ハンズフリーへ切替えると mic を有効化し、PTT へ戻すと mute する", async () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("モード切替のたびに agent へ mic_mode を通知する", () => {
    const sendMicMode = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendMicMode })));
    act(() => result.current.setMode("handsfree"));
    expect(sendMicMode).toHaveBeenLastCalledWith("handsfree");
    act(() => result.current.setMode("ptt"));
    expect(sendMicMode).toHaveBeenLastCalledWith("ptt");
  });

  it("接続済みのルームではマウント時に現在の mic_mode を通知する", () => {
    const sendMicMode = vi.fn();
    renderHook(() => usePushToTalk(opts({ sendMicMode })));
    expect(sendMicMode).toHaveBeenCalledWith("ptt");
  });

  it("手動ミュート中に PTT を往復してもミュートが解除されない", async () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
    participant.isMicrophoneEnabled = false;
    setMicrophoneEnabled.mockClear();
    act(() => result.current.setMode("ptt"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    expect(setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
  });

  it("押下開始で mic を有効化・capture を取り・turn_start を 1 回だけ送り、離すと turn_commit して mute する", async () => {
    const sendTurnStart = vi.fn();
    const sendTurnCommit = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnStart, sendTurnCommit })));

    const down = pointerEvent();
    act(() => result.current.pressProps.onPointerDown(down));
    expect(result.current.pttPressed).toBe(true);
    expect(sendTurnStart).toHaveBeenCalledTimes(1);
    expect(sendTurnCommit).not.toHaveBeenCalled();
    expect(
      (down.currentTarget as unknown as { setPointerCapture: ReturnType<typeof vi.fn> })
        .setPointerCapture,
    ).toHaveBeenCalledWith(1);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));

    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    expect(sendTurnStart).toHaveBeenCalledTimes(1);

    act(() => result.current.pressProps.onPointerUp());
    expect(result.current.pttPressed).toBe(false);
    expect(sendTurnCommit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("pointerleave / pointercancel / lostpointercapture でも確実に turn_commit して mute する", () => {
    const sendTurnCommit = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnCommit })));
    let committed = 0;
    for (const end of ["onPointerLeave", "onPointerCancel", "onLostPointerCapture"] as const) {
      act(() => result.current.pressProps.onPointerDown(pointerEvent()));
      expect(result.current.pttPressed).toBe(true);
      act(() => result.current.pressProps[end]());
      expect(result.current.pttPressed).toBe(false);
      committed += 1;
      expect(sendTurnCommit).toHaveBeenCalledTimes(committed);
    }
  });

  it("マウスは主ボタン以外の押下を無視する", () => {
    const sendTurnStart = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnStart })));
    act(() =>
      result.current.pressProps.onPointerDown(pointerEvent({ pointerType: "mouse", button: 2 })),
    );
    expect(result.current.pttPressed).toBe(false);
    expect(sendTurnStart).not.toHaveBeenCalled();
  });

  it("Space 長押しで押下し keyup で解除する（repeat は再送しない）", () => {
    const sendTurnStart = vi.fn();
    const sendTurnCommit = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnStart, sendTurnCommit })));

    fireEvent.keyDown(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(true);
    expect(sendTurnStart).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { code: "Space", repeat: true });
    expect(sendTurnStart).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    expect(sendTurnCommit).toHaveBeenCalledTimes(1);
  });

  it("input フォーカス中の Space では押下しない", () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    input.remove();
  });

  it("button フォーカス中の Space では押下しない（Space によるボタン活性化を奪わない）", () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    const button = document.createElement("button");
    document.body.appendChild(button);
    fireEvent.keyDown(button, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    button.remove();
  });

  it("ポインタ押下中は input での Space keyup で解除されない（起点別に解除）", () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
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
    const sendTurnStart = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnStart })));
    act(() => result.current.setMode("handsfree"));
    fireEvent.keyDown(window, { code: "Space" });
    expect(result.current.pttPressed).toBe(false);
    expect(sendTurnStart).not.toHaveBeenCalled();
  });

  it("window blur で turn_commit して mute する（押しっぱなし漏れ防止）", async () => {
    const sendTurnCommit = vi.fn();
    const { result } = renderHook(() => usePushToTalk(opts({ sendTurnCommit })));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    fireEvent.blur(window);
    expect(result.current.pttPressed).toBe(false);
    expect(sendTurnCommit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("押下中にハンズフリーへ切替えると押下状態を捨てて mic を有効化する", async () => {
    const { result } = renderHook(() => usePushToTalk(opts()));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    act(() => result.current.setMode("handsfree"));
    expect(result.current.pttPressed).toBe(false);
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
  });

  it("押下中のままアンマウントされたら mute する（押しっぱなし漏れ防止）", async () => {
    const { result, unmount } = renderHook(() => usePushToTalk(opts()));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
    unmount();
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
  });

  it("ハンズフリー経由で PTT に入った後のアンマウントで切替前の状態を復元する", async () => {
    const { result, unmount } = renderHook(() => usePushToTalk(opts()));
    act(() => result.current.setMode("handsfree"));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(true));
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
    const { result } = renderHook(() => usePushToTalk(opts()));
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
    const { result } = renderHook(() => usePushToTalk(opts({ onError })));
    await waitFor(() => expect(setMicrophoneEnabled).toHaveBeenLastCalledWith(false));

    setMicrophoneEnabled.mockRejectedValueOnce(new Error("permission denied"));
    act(() => result.current.pressProps.onPointerDown(pointerEvent()));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pttPressed).toBe(false));
  });
});
