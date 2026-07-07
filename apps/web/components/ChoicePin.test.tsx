// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoicePin, type ChoiceOptionFull } from "./ChoicePin";

const options: ChoiceOptionFull[] = [
  { label: "新しき順", sub: "新着を上に", effect: "鮮度が高い", caution: "古い物が埋もれる" },
  { label: "ゆかりの深き順", sub: "関連度で並べる", effect: "迷いが減る", caution: "主観が入る" },
  { label: "その他（話す/入力）", fixed: true },
];

function renderPin(onAnswer = vi.fn()) {
  render(<ChoicePin question="いずれを上座に据えまするか" options={options} onAnswer={onAnswer} />);
  return onAnswer;
}

describe("ChoicePin（フック＋strip/detail/compare の結線）", () => {
  afterEach(() => cleanup());

  it("初期は最小構成（問い＋chip）を出す", () => {
    renderPin();
    expect(screen.getByText("いずれを上座に据えまするか")).toBeTruthy();
    expect(screen.getByRole("button", { name: /新しき順/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /広げる/ })).toBeTruthy();
  });

  it("広げる→一覧、詳細›→詳細シート、これを選ぶ→onAnswer して閉じる", () => {
    const onAnswer = renderPin();
    fireEvent.click(screen.getByRole("button", { name: /広げる/ }));
    expect(screen.getByRole("button", { name: /閉じる/ })).toBeTruthy();
    const details = screen.getAllByRole("button", { name: /詳細/ });
    fireEvent.click(details[1]);
    expect(screen.getByText("選択肢の詳細")).toBeTruthy();
    expect(screen.getByText("ゆかりの深き順")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /選ぶ/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
    expect(screen.queryByText("選択肢の詳細")).toBeNull();
    expect(screen.queryByText("いずれを上座に据えまするか")).toBeNull();
  });

  it("詳細表示中に選択肢が減ってもクラッシュしない（focused をクランプ）", () => {
    const three: ChoiceOptionFull[] = [
      { label: "甲", effect: "e1" },
      { label: "乙", effect: "e2" },
      { label: "丙", effect: "e3" },
    ];
    const { rerender } = render(<ChoicePin question="q" options={three} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /広げる/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /詳細/ })[2]);
    expect(screen.getByText("選択肢の詳細")).toBeTruthy();
    const two: ChoiceOptionFull[] = [
      { label: "甲", effect: "e1" },
      { label: "乙", effect: "e2" },
    ];
    expect(() =>
      rerender(<ChoicePin question="q" options={two} onAnswer={vi.fn()} />),
    ).not.toThrow();
  });

  it("同一文言・同数でも questionId が変われば再表示する（連続検知で回答できなくなるのを防ぐ）", () => {
    const onAnswer = vi.fn();
    const two: ChoiceOptionFull[] = [{ label: "甲" }, { label: "乙" }];
    const { rerender } = render(
      <ChoicePin questionId="q1" question="どちらを採りますか" options={two} onAnswer={onAnswer} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /甲/ }));
    expect(onAnswer).toHaveBeenCalledWith(0);
    expect(screen.queryByText("どちらを採りますか")).toBeNull();
    rerender(
      <ChoicePin questionId="q2" question="どちらを採りますか" options={two} onAnswer={onAnswer} />,
    );
    expect(screen.getByText("どちらを採りますか")).toBeTruthy();
  });

  it("詳細→比較で ChoiceCompareSheet に切り替わる", () => {
    renderPin();
    fireEvent.click(screen.getByRole("button", { name: /広げる/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /詳細/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: /比較/ }));
    expect(screen.getByText("選択肢を見比べる")).toBeTruthy();
  });
});
