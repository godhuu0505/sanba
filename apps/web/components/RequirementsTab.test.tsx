// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Detection, Requirement } from "@/lib/realtime/types";

import { RequirementsTab } from "./RequirementsTab";

const req = (over: Partial<Requirement>): Requirement => ({
  id: "r1",
  statement: "検索バーを新設する",
  category: "functional",
  priority: "must",
  confidence: 0.9,
  source_speaker: "発話×画面",
  citations: [],
  status: "confirmed",
  ...over,
});

const det = (over: Partial<Detection>): Detection => ({
  id: "d1",
  kind: "contradiction",
  summary: "並び順の両論あり",
  refs: [],
  detector: "x",
  resolved: false,
  ...over,
});

describe("RequirementsTab（要件絵巻タブ・閲覧のみ＋深掘り）", () => {
  afterEach(() => cleanup());

  it("MoSCoW 区分で要件を閲覧表示する（statement・確信・出所）", () => {
    render(<RequirementsTab requirements={[req({})]} deepDive={[]} onJump={vi.fn()} />);
    expect(screen.getByText(/Must/)).toBeTruthy(); // priorityLabel = "Must 必須"
    expect(screen.getByText("検索バーを新設する")).toBeTruthy();
    expect(screen.getByText(/確信 高/)).toBeTruthy();
    expect(screen.getByText(/発話×画面/)).toBeTruthy();
  });

  it("要件が無いときは『まだ要件はありません』", () => {
    render(<RequirementsTab requirements={[]} deepDive={[]} onJump={vi.fn()} />);
    expect(screen.getByText(/まだ要件はありません/)).toBeTruthy();
  });

  it("深掘り対象を統合表示し、会話で確認で onJump(検知id) が呼ばれる", () => {
    const onJump = vi.fn();
    render(
      <RequirementsTab
        requirements={[req({})]}
        deepDive={[det({ id: "d9", kind: "contradiction" })]}
        onJump={onJump}
      />,
    );
    expect(screen.getByText(/矛盾/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /会話で確認/ }));
    expect(onJump).toHaveBeenCalledWith("d9");
  });

  it("focusUnresolved=true で深掘りへスクロールしワンショット消費する (#195)", () => {
    const onConsumed = vi.fn();
    // jsdom は scrollIntoView 未実装のためスパイを差す（呼び出し到達と消費を検証）。
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(
      <RequirementsTab
        requirements={[req({})]}
        deepDive={[det({})]}
        onJump={vi.fn()}
        focusUnresolved
        onUnresolvedFocusConsumed={onConsumed}
      />,
    );
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("focusUnresolved=false（要件タップ等）ではスクロールしない (#195)", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(<RequirementsTab requirements={[req({})]} deepDive={[det({})]} onJump={vi.fn()} />);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
