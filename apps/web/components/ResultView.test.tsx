// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Priority, Requirement } from "../lib/realtime/types";
import { ResultView } from "./ResultView";

function req(id: string, priority: Priority, statement: string): Requirement {
  return {
    id,
    statement,
    category: "functional",
    priority,
    confidence: 0.9,
    source_speaker: "user",
    citations: [],
    status: "confirmed",
  };
}

function setup(over: Partial<React.ComponentProps<typeof ResultView>> = {}) {
  const cb = {
    onView: vi.fn(),
    onRestart: vi.fn(),
    onExportPdf: vi.fn(),
    onExportDrive: vi.fn(),
    onExportIssue: vi.fn(),
  };
  render(<ResultView confirmedCount={8} {...cb} {...over} />);
  return cb;
}

describe("ResultView（要件産婆結果）", () => {
  afterEach(() => cleanup());

  it("祝祭メッセージと確定件数を出す", () => {
    setup();
    expect(screen.getByText(/産まれました/)).toBeTruthy();
    expect(screen.getByText(/8/)).toBeTruthy();
  });

  it("『画面で確認』(必須)で onView、『新しい問答』で onRestart", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /画面で確認/ }));
    expect(cb.onView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /新しい問答/ }));
    expect(cb.onRestart).toHaveBeenCalledTimes(1);
  });

  it("出力（PDF/Drive/Issue）は任意で、ハンドラがあれば押下で呼ぶ", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /PDF/ }));
    expect(cb.onExportPdf).toHaveBeenCalledTimes(1);
  });

  it("出力ハンドラ未指定のボタンは出さない", () => {
    setup({ onExportDrive: undefined, onExportIssue: undefined });
    expect(screen.queryByRole("button", { name: /Drive/ })).toBeNull();
    expect(screen.getByRole("button", { name: /PDF/ })).toBeTruthy();
  });

  it("provisional（未確定のまま終了）のときは確定でなく暫定の表記にする", () => {
    setup({ provisional: true });
    expect(screen.queryByText(/産まれました/)).toBeNull();
    expect(screen.getAllByText(/暫定/).length).toBeGreaterThan(0);
    expect(screen.getByText(/未確定を残したまま/)).toBeTruthy();
  });

  it("requirements 未指定ならプレビューリストは出さない（件数サマリのみ）", () => {
    setup();
    expect(screen.queryByLabelText("確定要件のプレビュー")).toBeNull();
  });

  it("Must/Should の要件行をプレビュー表示する", () => {
    setup({
      confirmedCount: 2,
      requirements: [
        req("m1", "must", "ログインできること"),
        req("s1", "should", "パスワード再設定ができること"),
      ],
    });
    // 名前付き group ランドマークとして公開する（aria-label が AT に確実に届く）。
    const preview = screen.getByRole("group", { name: "確定要件のプレビュー" });
    expect(preview).toBeTruthy();
    expect(screen.getByText("ログインできること")).toBeTruthy();
    expect(screen.getByText("パスワード再設定ができること")).toBeTruthy();
    // 見出し（Must/Should）が出る。
    expect(screen.getByText(/Must/)).toBeTruthy();
    expect(screen.getByText(/Should/)).toBeTruthy();
    // 超過がなければ「ほか N 件」は出さない。
    expect(screen.queryByText(/ほか/)).toBeNull();
  });

  it("超過分は「ほか N 件 ›」で畳み、押下で onView（全文導線）", () => {
    const cb = setup({
      confirmedCount: 7,
      requirements: [
        req("m1", "must", "M1"),
        req("m2", "must", "M2"),
        req("m3", "must", "M3"),
        // SECTION_LIMIT(3) 超過の Must は畳む。
        req("m4", "must", "M4"),
        req("s1", "should", "S1"),
        // Could/Won't はプレビュー対象外（畳む）。
        req("c1", "could", "C1"),
        req("w1", "wont", "W1"),
      ],
    });
    // プレビューは Must 上位3 + Should 1 = 4 件。残り3件が「ほか」。
    expect(screen.getByText("M1")).toBeTruthy();
    expect(screen.getByText("M3")).toBeTruthy();
    expect(screen.queryByText("M4")).toBeNull();
    expect(screen.queryByText("C1")).toBeNull();
    const more = screen.getByText(/ほか 3 件/);
    fireEvent.click(more);
    expect(cb.onView).toHaveBeenCalledTimes(1);
  });

  it("空の優先度セクションは非表示（Should が無ければ Should 見出しを出さない）", () => {
    setup({
      confirmedCount: 1,
      requirements: [req("m1", "must", "唯一の必須要件")],
    });
    expect(screen.getByText(/Must/)).toBeTruthy();
    expect(screen.queryByText(/Should/)).toBeNull();
    // Could のみでも Must/Should 見出しは出ず、全件が「ほか」へ。
    cleanup();
    setup({ confirmedCount: 2, requirements: [req("c1", "could", "C1"), req("w1", "wont", "W1")] });
    expect(screen.queryByText(/Must/)).toBeNull();
    expect(screen.queryByText(/Should/)).toBeNull();
    expect(screen.getByText(/ほか 2 件/)).toBeTruthy();
  });
});
