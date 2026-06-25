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
    expect(screen.getByRole("button", { name: /閉じる/ })).toBeTruthy(); // 一覧の⤡閉じる
    // 2番目の選択肢の詳細を開く
    const details = screen.getAllByRole("button", { name: /詳細/ });
    fireEvent.click(details[1]);
    expect(screen.getByText("選択肢の詳細")).toBeTruthy();
    expect(screen.getByText("ゆかりの深き順")).toBeTruthy();
    // これを選ぶ
    fireEvent.click(screen.getByRole("button", { name: /選ぶ/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
    // 回答後は選択肢UIが閉じる（hidden）
    expect(screen.queryByText("選択肢の詳細")).toBeNull();
    expect(screen.queryByText("いずれを上座に据えまするか")).toBeNull();
  });

  it("詳細→比較で ChoiceCompareSheet に切り替わる", () => {
    renderPin();
    fireEvent.click(screen.getByRole("button", { name: /広げる/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /詳細/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: /比較/ }));
    expect(screen.getByText("選択肢を見比べる")).toBeTruthy();
  });
});
