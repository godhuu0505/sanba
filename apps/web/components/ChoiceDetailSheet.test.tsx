// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceDetailSheet, type ChoiceOptionDetail } from "./ChoiceDetailSheet";

const option: ChoiceOptionDetail = {
  label: "新しき順",
  how: "更新日時の新しい順に並べます。",
  effect: "最新の検討状況を掴みやすい。",
  caution: "重要でも古い項目が埋もれる。",
  source: "発話×画面",
};

function setup(over: Partial<React.ComponentProps<typeof ChoiceDetailSheet>> = {}) {
  const cb = {
    onSelect: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
    onCompare: vi.fn(),
  };
  render(<ChoiceDetailSheet option={option} index={0} total={3} {...cb} {...over} />);
  return cb;
}

describe("ChoiceDetailSheet（選択肢の詳細確認）", () => {
  afterEach(() => cleanup());

  it("選択肢名と各観点（どう動く/効き目/留意/出所）を出す", () => {
    setup();
    expect(screen.getByText("新しき順")).toBeTruthy();
    expect(screen.getByText(/更新日時の新しい順/)).toBeTruthy();
    expect(screen.getByText(/最新の検討状況/)).toBeTruthy();
    expect(screen.getByText(/古い項目が埋もれる/)).toBeTruthy();
    expect(screen.getByText(/発話×画面/)).toBeTruthy();
  });

  it("『選ぶ』『前』『次』『比較』『閉じる』が各コールバックを呼ぶ", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /選ぶ/ }));
    expect(cb.onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /前/ }));
    expect(cb.onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /次/ }));
    expect(cb.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /比較/ }));
    expect(cb.onCompare).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /閉じる/ }));
    expect(cb.onClose).toHaveBeenCalledTimes(1);
  });

  it("未指定の観点は出さない", () => {
    setup({ option: { label: "保留", how: undefined, effect: undefined } });
    expect(screen.getByText("保留")).toBeTruthy();
    expect(screen.queryByText(/効き目/)).toBeNull();
  });
});
