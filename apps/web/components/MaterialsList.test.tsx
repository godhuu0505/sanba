// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialsList, type MaterialItem } from "./MaterialsList";

const item = (over: Partial<MaterialItem>): MaterialItem => ({
  id: "a1",
  name: "資料.png",
  pct: 100,
  status: "done",
  ...over,
});

describe("MaterialsList（参考資料タブ・解析進捗つき）", () => {
  afterEach(() => cleanup());

  it("空のときは未投入メッセージと『素材を追加』を出す", () => {
    render(<MaterialsList items={[]} onAdd={vi.fn()} />);
    expect(screen.getByText(/まだありません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /素材を追加/ })).toBeTruthy();
  });

  it("解析中はファイル名・進捗バー(aria-valuenow)・% を出す", () => {
    render(
      <MaterialsList
        items={[item({ id: "a1", name: "一覧_モック.png", pct: 62, status: "analyzing" })]}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByText("一覧_モック.png")).toBeTruthy();
    expect(screen.getByText(/解析中/)).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText(/62%/)).toBeTruthy();
  });

  it("完了は『解析済』を出す（進捗バーは出さない）", () => {
    render(<MaterialsList items={[item({ name: "PRD.pdf", status: "done" })]} onAdd={vi.fn()} />);
    expect(screen.getByText("PRD.pdf")).toBeTruthy();
    expect(screen.getByText(/解析済/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("失敗は再試行ボタンを出す（onRetry 指定時）", () => {
    const onRetry = vi.fn();
    render(<MaterialsList items={[item({ id: "x", status: "failed" })]} onAdd={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /再試行/ }));
    expect(onRetry).toHaveBeenCalledWith("x");
  });

  it("onRetry 未指定なら再試行ボタンを出さない", () => {
    render(<MaterialsList items={[item({ status: "failed" })]} onAdd={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /再試行/ })).toBeNull();
  });

  it("『素材を追加』で onAdd が呼ばれる", () => {
    const onAdd = vi.fn();
    render(<MaterialsList items={[]} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /素材を追加/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
