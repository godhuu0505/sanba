// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Detection } from "@/lib/realtime/types";

import { JudgmentGate } from "./JudgmentGate";

const det = (over: Partial<Detection>): Detection => ({
  id: "d1",
  kind: "contradiction",
  summary: "並び順の両論",
  refs: [],
  detector: "x",
  resolved: false,
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

  it("未解消の内訳を渡すと項目を表示し、会話で確認で onJump(検知id)", () => {
    const onJump = vi.fn();
    render(
      <JudgmentGate
        unresolved={1}
        detections={[det({ id: "d3", kind: "contradiction" })]}
        onJump={onJump}
        onBack={vi.fn()}
        onForceEnd={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/食い違い/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /会話で確認/ }));
    expect(onJump).toHaveBeenCalledWith("d3");
  });
});
