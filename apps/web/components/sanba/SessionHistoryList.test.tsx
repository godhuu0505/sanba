// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionHistoryList, type SessionHistoryItem } from "./SessionHistoryList";

// 01 ホーム「過去の要件を見る」履歴リスト（#215 / Figma 正本 99:3）。
// 空状態の文言・行の描画・遷移先 href・色のみ非依存の手掛かりを検証する。

const ITEMS: SessionHistoryItem[] = [
  { id: "s1", title: "新機能要件定義", date: "2024/06/20" },
  { id: "s2", title: "決済フロー見直し", date: "2024/06/18" },
];

describe("SessionHistoryList（過去の要件を見る）", () => {
  afterEach(() => cleanup());

  it("見出し「過去の要件を見る」を常に出す", () => {
    render(<SessionHistoryList items={[]} />);
    expect(screen.getByRole("heading", { name: "過去の要件を見る" })).toBeTruthy();
  });

  it("空配列のときは空状態の文言を出し、遷移リンクは出さない", () => {
    render(<SessionHistoryList items={[]} />);
    expect(screen.getByText(/過去の要件はまだございません/)).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("emptyText を渡すと空状態の文言を差し替えられる", () => {
    render(<SessionHistoryList items={[]} emptyText="まだ何もありません" />);
    expect(screen.getByText("まだ何もありません")).toBeTruthy();
  });

  it("items があると標題・日付・末尾シェブロン › を行ごとに出す", () => {
    render(<SessionHistoryList items={ITEMS} />);
    expect(screen.getByText("新機能要件定義")).toBeTruthy();
    expect(screen.getByText("2024/06/20")).toBeTruthy();
    expect(screen.getByText("決済フロー見直し")).toBeTruthy();
    // 色のみに依存しない遷移手掛かり（シェブロン）が各行にある。
    expect(screen.getAllByText("›")).toHaveLength(ITEMS.length);
  });

  it("各行はリンクで、既定の遷移先は /admin?session={id}", () => {
    render(<SessionHistoryList items={ITEMS} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(ITEMS.length);
    expect(links[0].getAttribute("href")).toBe("/admin?session=s1");
  });

  it("hrefFor を渡すと遷移先を差し替えられる", () => {
    render(<SessionHistoryList items={ITEMS} hrefFor={(id) => `/sessions/${id}`} />);
    const links = screen.getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe("/sessions/s1");
  });
});
