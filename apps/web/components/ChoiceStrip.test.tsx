// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceStrip, type ChoiceOption } from "./ChoiceStrip";

const opts: ChoiceOption[] = [
  { label: "新しき順", sub: "新着を上に" },
  { label: "ゆかりの深き順", sub: "関連度で並べる" },
  { label: "その他（話す/入力）", fixed: true },
];

function setup(over: Partial<React.ComponentProps<typeof ChoiceStrip>> = {}) {
  const cb = {
    onSelect: vi.fn(),
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    onOpenDetail: vi.fn(),
  };
  render(
    <ChoiceStrip
      mode="min"
      question="いずれを上座に据えまするか"
      options={opts}
      {...cb}
      {...over}
    />,
  );
  return cb;
}

describe("ChoiceStrip（問いピン・最小/一覧）", () => {
  afterEach(() => cleanup());

  it("最小: 問い＋各選択肢chip＋『広げる』を出し、chipタップで onSelect(index)", () => {
    const cb = setup();
    expect(screen.getByText("いずれを上座に据えまするか")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /新しき順/ }));
    expect(cb.onSelect).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: /広げる/ }));
    expect(cb.onExpand).toHaveBeenCalledTimes(1);
  });

  it("一覧: 行タップで onSelect(index)、各行の『詳細』で onOpenDetail(index)、『閉じる』で onCollapse", () => {
    const cb = setup({ mode: "list" });
    // 行（選択）ボタン
    fireEvent.click(screen.getByRole("button", { name: /ゆかりの深き順/ }));
    expect(cb.onSelect).toHaveBeenCalledWith(1);
    // 詳細ボタン（動的選択肢のみ）→ 2番目の詳細
    const details = screen.getAllByRole("button", { name: /詳細/ });
    fireEvent.click(details[1]);
    expect(cb.onOpenDetail).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: /閉じる/ }));
    expect(cb.onCollapse).toHaveBeenCalledTimes(1);
  });

  it("最小: 動的chipの長押しで onOpenDetail(index)（一覧を経由しない近道）", () => {
    vi.useFakeTimers();
    try {
      const cb = setup();
      fireEvent.pointerDown(screen.getByRole("button", { name: /新しき順/ }));
      act(() => vi.advanceTimersByTime(600));
      expect(cb.onOpenDetail).toHaveBeenCalledWith(0);
      expect(cb.onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("最小: 短いタップは onSelect（長押しにならない）", () => {
    vi.useFakeTimers();
    try {
      const cb = setup();
      const chip = screen.getByRole("button", { name: /新しき順/ });
      fireEvent.pointerDown(chip);
      act(() => vi.advanceTimersByTime(100));
      fireEvent.pointerUp(chip);
      fireEvent.click(chip);
      expect(cb.onSelect).toHaveBeenCalledWith(0);
      expect(cb.onOpenDetail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("最小: 長押し中に pointercancel されたらタイマーを止める（スクロール中の誤展開を防ぐ）", () => {
    vi.useFakeTimers();
    try {
      const cb = setup();
      const chip = screen.getByRole("button", { name: /新しき順/ });
      fireEvent.pointerDown(chip);
      fireEvent.pointerCancel(chip);
      act(() => vi.advanceTimersByTime(600));
      expect(cb.onOpenDetail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("検知（矛盾）のときは検知バッジを出す", () => {
    setup({ detectionKind: "contradiction" });
    expect(screen.getByText(/矛盾/)).toBeTruthy();
  });

  it("選択肢が空なら何も描画しない", () => {
    const { container } = render(
      <ChoiceStrip
        mode="min"
        question=""
        options={[]}
        onSelect={vi.fn()}
        onExpand={vi.fn()}
        onCollapse={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
