// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceCompareSheet, type CompareRow } from "./ChoiceCompareSheet";

const rows: CompareRow[] = [
  { label: "新しき順", effect: "鮮度が高い", caution: "古い物が埋もれる" },
  { label: "価格の安き順", effect: "コスト最優先", caution: "質と乖離も" },
];

describe("ChoiceCompareSheet（選択肢の比較）", () => {
  afterEach(() => cleanup());

  it("各選択肢を効き目/留意で見比べて表示する", () => {
    render(<ChoiceCompareSheet rows={rows} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("新しき順")).toBeTruthy();
    expect(screen.getByText("鮮度が高い")).toBeTruthy();
    expect(screen.getByText("古い物が埋もれる")).toBeTruthy();
    expect(screen.getByText("価格の安き順")).toBeTruthy();
  });

  it("行の『選ぶ』で onSelect(index)", () => {
    const onSelect = vi.fn();
    render(<ChoiceCompareSheet rows={rows} onSelect={onSelect} onClose={vi.fn()} />);
    const picks = screen.getAllByRole("button", { name: /選ぶ/ });
    fireEvent.click(picks[1]);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("『閉じる』で onClose", () => {
    const onClose = vi.fn();
    render(<ChoiceCompareSheet rows={rows} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /閉じる/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
