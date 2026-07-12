// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EndConfirmDialog } from "./EndConfirmDialog";

describe("EndConfirmDialog（終了確認）", () => {
  afterEach(() => cleanup());

  it("未解消ありのときは件数と注意を出し、続ける/終了するを出す", () => {
    render(<EndConfirmDialog unresolved={2} onContinue={vi.fn()} onEnd={vi.fn()} />);
    expect(screen.getByText(/会話を終えますか/)).toBeTruthy();
    expect(screen.getByText(/2 件/)).toBeTruthy();
    expect(screen.getByText(/確定されません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /続ける/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /終了する/ })).toBeTruthy();
  });

  it("続ける/終了する が各コールバックを呼ぶ", () => {
    const onContinue = vi.fn();
    const onEnd = vi.fn();
    render(<EndConfirmDialog unresolved={1} onContinue={onContinue} onEnd={onEnd} />);
    fireEvent.click(screen.getByRole("button", { name: /続ける/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /終了する/ }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("未解消0なら注意を出さない", () => {
    render(<EndConfirmDialog unresolved={0} onContinue={vi.fn()} onEnd={vi.fn()} />);
    expect(screen.queryByText(/確定されません/)).toBeNull();
    expect(screen.getByText(/未解消はありません/)).toBeTruthy();
  });

  it("loading 中は進捗表示に切り替え、両ボタンを無効化して二重終了を防ぐ", () => {
    const onEnd = vi.fn();
    const onContinue = vi.fn();
    render(
      <EndConfirmDialog unresolved={0} onContinue={onContinue} onEnd={onEnd} loading />,
    );
    expect(screen.getByText(/まとめています/)).toBeTruthy();
    const end = screen.getByRole("button", { name: /まとめています/ });
    expect(end.getAttribute("aria-busy")).toBe("true");
    expect((end as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(end);
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /続ける/ }));
    expect(onContinue).not.toHaveBeenCalled();
  });
});
