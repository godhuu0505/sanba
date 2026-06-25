// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JudgmentGate } from "./JudgmentGate";

function setup(over: Partial<React.ComponentProps<typeof JudgmentGate>> = {}) {
  const cb = { onBack: vi.fn(), onForceEnd: vi.fn(), onConfirm: vi.fn() };
  render(<JudgmentGate unresolved={2} {...cb} {...over} />);
  return cb;
}

describe("JudgmentGate（確定ゲート）", () => {
  afterEach(() => cleanup());

  it("未解消ありは確定不可。戻る/終うを出し、確定ボタンは出さない", () => {
    setup({ unresolved: 2 });
    expect(screen.getByText(/未解消 2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /問答に戻/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /未解消のまま/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /要件を確定/ })).toBeNull();
  });

  it("全解消は確定でき、確定で onConfirm。終うは出さない", () => {
    const cb = setup({ unresolved: 0 });
    const confirm = screen.getByRole("button", { name: /要件を確定/ });
    fireEvent.click(confirm);
    expect(cb.onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /未解消のまま/ })).toBeNull();
  });

  it("戻る/終う が各コールバックを呼ぶ", () => {
    const cb = setup({ unresolved: 1 });
    fireEvent.click(screen.getByRole("button", { name: /問答に戻/ }));
    expect(cb.onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /未解消のまま/ }));
    expect(cb.onForceEnd).toHaveBeenCalledTimes(1);
  });
});
