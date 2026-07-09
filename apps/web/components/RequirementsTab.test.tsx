// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InquiryNode, Requirement } from "@/lib/realtime/types";

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

const node = (over: Partial<InquiryNode> & { id: string }): InquiryNode => ({
  parent_id: null,
  kind: "gap",
  text: "並びが未定",
  status: "open",
  confidence: 0.6,
  depth: 0,
  origin: "conversation",
  refs: [],
  created_seq: 1,
  resolved_seq: null,
  ...over,
});

describe("RequirementsTab（要件一覧タブ・閲覧のみ＋確認事項ツリー）", () => {
  afterEach(() => cleanup());

  it("MoSCoW 区分で要件を閲覧表示する（statement・確信度・発言者）", () => {
    render(<RequirementsTab requirements={[req({})]} nodes={[]} />);
    expect(screen.getByText(/ぜひ必要/)).toBeTruthy();
    expect(screen.getByText("検索バーを新設する")).toBeTruthy();
    expect(screen.getByText(/確信度 高/)).toBeTruthy();
    expect(screen.getByText(/発話×画面/)).toBeTruthy();
  });

  it("要件が無いときは『まだ要件はありません』", () => {
    render(<RequirementsTab requirements={[]} nodes={[]} />);
    expect(screen.getByText(/まだ要件はありません/)).toBeTruthy();
  });

  it("確認事項ツリーを表示し、ヘッダに未解消（ゲート）件数を出す", () => {
    render(
      <RequirementsTab
        requirements={[req({})]}
        nodes={[node({ id: "n1", kind: "contradiction", text: "並び順の両論あり" })]}
      />,
    );
    expect(screen.getByText("確認事項ツリー")).toBeTruthy();
    expect(screen.getByText("並び順の両論あり")).toBeTruthy();
    expect(screen.getByText(/食い違い/)).toBeTruthy();
    expect(screen.getByText(/未解消 1/)).toBeTruthy();
  });

  it("ノードの『不要』で onDrop(nodeId) を呼ぶ", () => {
    const onDrop = vi.fn();
    render(
      <RequirementsTab
        requirements={[req({})]}
        nodes={[node({ id: "n9", text: "並びが未定" })]}
        onDrop={onDrop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /不要にする/ }));
    expect(onDrop).toHaveBeenCalledWith("n9");
  });

  it("focusUnresolved=true でツリーへスクロールしワンショット消費する (#195)", () => {
    const onConsumed = vi.fn();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(
      <RequirementsTab
        requirements={[req({})]}
        nodes={[node({ id: "n1" })]}
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
    render(<RequirementsTab requirements={[req({})]} nodes={[node({ id: "n1" })]} />);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
