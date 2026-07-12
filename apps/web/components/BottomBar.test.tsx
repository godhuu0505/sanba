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
    const mute = screen.getByRole("button", { name: "スピーカー消音" });
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mute);
    expect(cb.onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("マイク・ミュートは micOn=true で未ミュート（aria-pressed=false / 集音中）", () => {
    const cb = setup({ micOn: true });
    const mic = screen.getByRole("button", { name: "マイクをミュート" });
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(mic.textContent).toContain("集音中");
    fireEvent.click(mic);
    expect(cb.onToggleMic).toHaveBeenCalledTimes(1);
  });

  it("マイク OFF はミュート中を明示する（aria-pressed=true / ミュート中）", () => {
    setup({ micOn: false });
    const mic = screen.getByRole("button", { name: "マイクをミュート" });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.textContent).toContain("ミュート中");
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

  it("Enter で送信できる（非変換時）", () => {
    const cb = setup();
    const input = screen.getByLabelText("テキストで入力");
    fireEvent.change(input, { target: { value: "規矩は何か" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cb.onSend).toHaveBeenCalledWith("規矩は何か");
  });

  it("IME 変換中（isComposing）の Enter では送信しない", () => {
    const cb = setup();
    const input = screen.getByLabelText("テキストで入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "かいぎ" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(cb.onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("かいぎ");
  });

  it("音声状態インジケータはボトムバーに出さない（上部固定領域へ移設）", () => {
    setup({ micOn: true, muted: false });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("BottomBar（PTT モード / ADR-0066 S3）", () => {
  afterEach(() => cleanup());

  it("onMicModeChange があればモードトグルを出し、既定はハンズフリー", () => {
    const onMicModeChange = vi.fn();
    setup({ onMicModeChange });
    expect(
      screen.getByRole("button", { name: "ハンズフリー" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "押して話す" }));
    expect(onMicModeChange).toHaveBeenCalledWith("ptt");
  });

  it("onMicModeChange が無ければトグルを出さない（既存利用の互換）", () => {
    setup();
    expect(screen.queryByRole("button", { name: "押して話す" })).toBeNull();
  });

  it("PTT モードは常設マイクボタンを隠し、大きな押下ボタンを出す", () => {
    setup({ onMicModeChange: vi.fn(), micMode: "ptt" });
    expect(screen.queryByRole("button", { name: "マイクをミュート" })).toBeNull();
    const ptt = screen.getByRole("button", { name: "押しながら話す" });
    expect(ptt.getAttribute("aria-pressed")).toBe("false");
    expect(ptt.textContent).toContain("押しながら話す");
  });

  it("押下中は aria-pressed=true で送話中表示になり、pressProps が結線される", () => {
    const onPointerDown = vi.fn();
    setup({
      onMicModeChange: vi.fn(),
      micMode: "ptt",
      pttPressed: true,
      pttPressProps: {
        onPointerDown,
        onPointerUp: vi.fn(),
        onPointerLeave: vi.fn(),
        onPointerCancel: vi.fn(),
        onContextMenu: vi.fn(),
      },
    });
    const ptt = screen.getByRole("button", { name: "押しながら話す" });
    expect(ptt.getAttribute("aria-pressed")).toBe("true");
    expect(ptt.textContent).toContain("送話中");
    fireEvent.pointerDown(ptt);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });
});
