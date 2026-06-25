// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BottomBar } from "./BottomBar";

function setup(over: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const cb = {
    onToggleMic: vi.fn(),
    onToggleMute: vi.fn(),
    onSend: vi.fn(),
  };
  render(<BottomBar micOn muted={false} {...cb} {...over} />);
  return cb;
}

describe("BottomBar（常時2行：消音/マイク・テキスト/送信）", () => {
  afterEach(() => cleanup());

  it("消音は muted を aria-pressed で表し、押下で onToggleMute", () => {
    const cb = setup({ muted: true });
    const mute = screen.getByRole("button", { name: "消音" });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mute);
    expect(cb.onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("マイク（会話）は micOn を aria-pressed で表し、押下で onToggleMic", () => {
    const cb = setup({ micOn: true });
    const mic = screen.getByRole("button", { name: "会話（マイク）" });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mic);
    expect(cb.onToggleMic).toHaveBeenCalledTimes(1);
  });

  it("テキストを入力して送信すると onSend(本文) を呼び、入力を空にする", () => {
    const cb = setup();
    const input = screen.getByLabelText("テキストで入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "検索バーが要る" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(cb.onSend).toHaveBeenCalledWith("検索バーが要る");
    expect(input.value).toBe("");
  });

  it("空のときは送信しない", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(cb.onSend).not.toHaveBeenCalled();
  });
});
