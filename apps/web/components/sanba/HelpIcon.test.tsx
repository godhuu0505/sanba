// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { HelpIcon } from "./HelpIcon";

beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("HelpIcon（用語ヘルプ・Radix Popover）", () => {
  afterEach(() => cleanup());

  it("? ボタンに aria-label を付け、初期は本文を出さない", () => {
    render(<HelpIcon term="前提リポジトリ" />);
    expect(screen.getByRole("button", { name: "前提リポジトリの説明" })).toBeTruthy();
    expect(screen.queryByText(/紐づけたコードを読み込み/)).toBeNull();
  });

  it("タップで見出しと本文を開く", () => {
    render(<HelpIcon term="確信度" />);
    fireEvent.click(screen.getByRole("button", { name: "確信度の説明" }));
    expect(screen.getByText("確信度とは")).toBeTruthy();
    expect(screen.getByText(/確からしいと判断したか/)).toBeTruthy();
  });
});
