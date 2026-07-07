// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionHistoryList, type SessionHistoryItem } from "./SessionHistoryList";

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

  it("items があると標題・日付＋セッションID・末尾シェブロン › を行ごとに出す", () => {
    render(<SessionHistoryList items={ITEMS} />);
    expect(screen.getByText("新機能要件定義")).toBeTruthy();
    expect(screen.getByText("2024/06/20 ・ s1")).toBeTruthy();
    expect(screen.getByText("決済フロー見直し")).toBeTruthy();
    expect(screen.getAllByText("›")).toHaveLength(ITEMS.length);
  });

  it("日付が空でもセッションIDはサブ行に出す", () => {
    render(<SessionHistoryList items={[{ id: "s9", title: "無題", date: "" }]} />);
    expect(screen.getByText("s9")).toBeTruthy();
  });

  it("各行はリンクで、既定の遷移先は過去要件の絵巻閲覧画面 /results/{id}", () => {
    render(<SessionHistoryList items={ITEMS} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(ITEMS.length);
    expect(links[0].getAttribute("href")).toBe("/results/s1");
  });

  it("hrefFor を渡すと遷移先を差し替えられる", () => {
    render(<SessionHistoryList items={ITEMS} hrefFor={(id) => `/archive/${id}`} />);
    const links = screen.getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe("/archive/s1");
  });
});
