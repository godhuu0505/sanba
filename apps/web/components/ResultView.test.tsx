// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResultView } from "./ResultView";

function setup(over: Partial<React.ComponentProps<typeof ResultView>> = {}) {
  const cb = {
    onView: vi.fn(),
    onRestart: vi.fn(),
    onExportPdf: vi.fn(),
    onExportDrive: vi.fn(),
    onExportIssue: vi.fn(),
  };
  render(<ResultView confirmedCount={8} {...cb} {...over} />);
  return cb;
}

describe("ResultView（要件産婆結果）", () => {
  afterEach(() => cleanup());

  it("祝祭メッセージと確定件数を出す", () => {
    setup();
    expect(screen.getByText(/産まれました/)).toBeTruthy();
    expect(screen.getByText(/8/)).toBeTruthy();
  });

  it("『画面で確認』(必須)で onView、『新しい問答』で onRestart", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /画面で確認/ }));
    expect(cb.onView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /新しい問答/ }));
    expect(cb.onRestart).toHaveBeenCalledTimes(1);
  });

  it("出力（PDF/Drive/Issue）は任意で、ハンドラがあれば押下で呼ぶ", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /PDF/ }));
    expect(cb.onExportPdf).toHaveBeenCalledTimes(1);
  });

  it("出力ハンドラ未指定のボタンは出さない", () => {
    setup({ onExportDrive: undefined, onExportIssue: undefined });
    expect(screen.queryByRole("button", { name: /Drive/ })).toBeNull();
    expect(screen.getByRole("button", { name: /PDF/ })).toBeTruthy();
  });

  it("provisional（未確定のまま終了）のときは確定でなく暫定の表記にする", () => {
    setup({ provisional: true });
    expect(screen.queryByText(/産まれました/)).toBeNull();
    expect(screen.getAllByText(/暫定/).length).toBeGreaterThan(0);
    expect(screen.getByText(/未確定を残したまま/)).toBeTruthy();
  });
});
