// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InquiryNode } from "@/lib/realtime/types";

import { JudgmentGate } from "./JudgmentGate";

const node = (over: Partial<InquiryNode> & { id: string }): InquiryNode => ({
  parent_id: null,
  kind: "contradiction",
  text: "並び順の両論",
  status: "open",
  confidence: 0.6,
  depth: 0,
  origin: "conversation",
  refs: [],
  created_seq: 1,
  resolved_seq: null,
  ...over,
});

function setup(over: Partial<React.ComponentProps<typeof JudgmentGate>> = {}) {
  const cb = { onBack: vi.fn(), onForceEnd: vi.fn(), onConfirm: vi.fn() };
  render(<JudgmentGate unresolved={2} {...cb} {...over} />);
  return cb;
}

describe("JudgmentGate（確定ゲート）", () => {
  afterEach(() => cleanup());

  it("未解消ありは確定不可。戻る/終えるを出し、確定ボタンは出さない", () => {
    setup({ unresolved: 2 });
    expect(screen.getByText(/未解消が 2 件あります/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /会話に戻って確認/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /未解消のまま/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /要件を確定/ })).toBeNull();
  });

  it("全解消は確定でき、確定で onConfirm。終えるは出さない", () => {
    const cb = setup({ unresolved: 0 });
    const confirm = screen.getByRole("button", { name: /要件を確定/ });
    fireEvent.click(confirm);
    expect(cb.onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /未解消のまま/ })).toBeNull();
  });

  it("戻る/終える が各コールバックを呼ぶ", () => {
    const cb = setup({ unresolved: 1 });
    fireEvent.click(screen.getByRole("button", { name: /会話に戻って確認/ }));
    expect(cb.onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /未解消のまま/ }));
    expect(cb.onForceEnd).toHaveBeenCalledTimes(1);
  });

  it("未解消の内訳（ツリー）を渡すと項目を表示し、不要で onDrop(nodeId)", () => {
    const onDrop = vi.fn();
    render(
      <JudgmentGate
        unresolved={1}
        nodes={[node({ id: "n3", kind: "contradiction", text: "退会導線の不一致" })]}
        onDrop={onDrop}
        onBack={vi.fn()}
        onForceEnd={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/食い違い/)).toBeTruthy();
    expect(screen.getByText("退会導線の不一致")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /不要にする/ }));
    expect(onDrop).toHaveBeenCalledWith("n3");
  });
});
