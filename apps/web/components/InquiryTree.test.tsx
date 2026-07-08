// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InquiryNode } from "@/lib/realtime/types";

import { InquiryTree } from "./InquiryTree";

const node = (over: Partial<InquiryNode> & { id: string }): InquiryNode => ({
  parent_id: null,
  kind: "gap",
  text: "確認したい点",
  status: "open",
  confidence: 0.6,
  depth: 0,
  origin: "conversation",
  refs: [],
  created_seq: 1,
  resolved_seq: null,
  ...over,
});

describe("InquiryTree（確認事項ロジックツリー・§06）", () => {
  afterEach(() => cleanup());

  it("空のときは『確認事項はありません』を出す", () => {
    render(<InquiryTree nodes={[]} />);
    expect(screen.getByText(/確認事項はありません/)).toBeTruthy();
  });

  it("kind 別のラベル（確認項目/確認したい点/あいまい/食い違い）を色非依存で出す", () => {
    render(
      <InquiryTree
        nodes={[
          node({ id: "c1", kind: "check", text: "確認項目ノード", created_seq: 1 }),
          node({ id: "g1", kind: "gap", text: "未確認ノード", created_seq: 2 }),
          node({ id: "a1", kind: "ambiguous", text: "あいまいノード", created_seq: 3 }),
          node({ id: "x1", kind: "contradiction", text: "矛盾ノード", created_seq: 4 }),
        ]}
      />,
    );
    expect(screen.getByText("確認項目")).toBeTruthy();
    expect(screen.getByText("確認したい点")).toBeTruthy();
    expect(screen.getByText("あいまい")).toBeTruthy();
    expect(screen.getByText("食い違い")).toBeTruthy();
    expect(screen.getByLabelText("あいまいな点")).toBeTruthy();
  });

  it("親子をインデントの木として表示する（子は親の下）", () => {
    render(
      <InquiryTree
        nodes={[
          node({ id: "root", kind: "check", text: "対象ユーザーの範囲", created_seq: 1 }),
          node({
            id: "child",
            kind: "gap",
            text: "保存タイミング",
            parent_id: "root",
            depth: 1,
            created_seq: 2,
          }),
        ]}
      />,
    );
    expect(screen.getByText("対象ユーザーの範囲")).toBeTruthy();
    expect(screen.getByText("保存タイミング")).toBeTruthy();
  });

  it("resolved は解消済表示（淡色＋✓）で残す", () => {
    render(
      <InquiryTree
        nodes={[node({ id: "r1", kind: "check", text: "解決した点", status: "resolved" })]}
      />,
    );
    expect(screen.getByText("解消済")).toBeTruthy();
  });

  it("タップで根拠 refs を表示する", () => {
    render(
      <InquiryTree
        nodes={[node({ id: "g1", text: "通知の保存タイミング", refs: ["u12", "u13"] })]}
      />,
    );
    expect(screen.queryByText(/根拠:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /通知の保存タイミング/ }));
    expect(screen.getByText(/根拠: u12 · u13/)).toBeTruthy();
  });

  it("open ノードの『不要』で onDrop(nodeId) を呼ぶ", () => {
    const onDrop = vi.fn();
    render(<InquiryTree nodes={[node({ id: "g9", text: "不要候補" })]} onDrop={onDrop} />);
    fireEvent.click(screen.getByRole("button", { name: /不要にする/ }));
    expect(onDrop).toHaveBeenCalledWith("g9");
  });

  it("dropped は既定非表示で、『除外 M』を開くと現れる", () => {
    render(
      <InquiryTree
        nodes={[
          node({ id: "g1", text: "表示ノード", status: "open" }),
          node({ id: "d1", text: "除外ノード", status: "dropped" }),
        ]}
      />,
    );
    expect(screen.queryByText("除外ノード")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /除外 1/ }));
    expect(screen.getByText("除外ノード")).toBeTruthy();
  });
});
