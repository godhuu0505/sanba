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
    const preview = screen.getByRole("group", { name: "確定要件のプレビュー" });
    expect(preview).toBeTruthy();
    expect(screen.getByText("ログインできること")).toBeTruthy();
    expect(screen.getByText("パスワード再設定ができること")).toBeTruthy();
    expect(screen.getByText(/Must/)).toBeTruthy();
    expect(screen.getByText(/Should/)).toBeTruthy();
    expect(screen.queryByText(/ほか/)).toBeNull();
  });

  it("超過分は「ほか N 件 ›」で畳み、押下で onView（全文導線）", () => {
    const cb = setup({
      confirmedCount: 7,
      requirements: [
        req("m1", "must", "M1"),
        req("m2", "must", "M2"),
        req("m3", "must", "M3"),
        req("m4", "must", "M4"),
        req("s1", "should", "S1"),
        req("c1", "could", "C1"),
        req("w1", "wont", "W1"),
      ],
    });
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
    cleanup();
    setup({ confirmedCount: 2, requirements: [req("c1", "could", "C1"), req("w1", "wont", "W1")] });
    expect(screen.queryByText(/Must/)).toBeNull();
    expect(screen.queryByText(/Should/)).toBeNull();
    expect(screen.getByText(/ほか 2 件/)).toBeTruthy();
  });

  it("session.completed のサーバ集計（矛盾解消/抜け/Issue）を再集計せず表示する (#144)", () => {
    setup({ summary: { contradictions_resolved: 3, gaps_found: 2, issues_created: 1 } });
    expect(screen.getByText(/矛盾解消 3 ・ 抜け検知 2 ・ Issue 起票 1/)).toBeTruthy();
  });

  it("summary 未提供（session.completed 未受信）なら集計行を出さない (#144)", () => {
    setup();
    expect(screen.queryByText(/矛盾解消/)).toBeNull();
  });

  it("artifacts のリンクを新規タブで開ける形で出す (#144)", () => {
    setup({
      artifacts: [{ kind: "PDF", url: "https://example.com/a.pdf" }],
    });
    const link = screen.getByRole("link", { name: /PDF を開く/ });
    expect(link.getAttribute("href")).toBe("https://example.com/a.pdf");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("javascript: 等の危険な scheme の artifact はリンクにしない (Codex P2 / XSS 防止)", () => {
    setup({
      artifacts: [
        { kind: "evil", url: "javascript:alert(1)" },
        { kind: "rel", url: "/relative/path" },
        { kind: "PDF", url: "https://example.com/ok.pdf" },
      ],
    });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /PDF を開く/ }).getAttribute("href")).toBe(
      "https://example.com/ok.pdf",
    );
    expect(screen.queryByText(/evil を開く/)).toBeNull();
  });

  it("起票中は Issue ボタンを無効化し『起票中…』を出す", () => {
    setup({ issueExport: { status: "pending" } });
    const btn = screen.getByRole("button", { name: /起票中…/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("起票成功なら Issue へのリンクを出す（安全な https のみ）", () => {
    setup({
      issueExport: { status: "done", url: "https://github.com/o/r/issues/1" },
    });
    const link = screen.getByRole("link", { name: /起票した Issue を開く/ });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/issues/1");
  });

  it("起票成功でも危険な URL はリンク化しない（フォールバック文言）", () => {
    setup({ issueExport: { status: "done", url: "javascript:alert(1)" } });
    expect(screen.queryByRole("link", { name: /起票した Issue/ })).toBeNull();
    expect(screen.getByText(/Issue を起票しました/)).toBeTruthy();
  });

  it("起票失敗は reason を日本語に言い換えて表示する", () => {
    setup({ issueExport: { status: "error", reason: "github repo not allowed" } });
    expect(screen.getByText(/許可されていないリポジトリ/)).toBeTruthy();
  });

  it("Issue ハンドラ未指定なら起票結果は表示しない", () => {
    setup({ onExportIssue: undefined, issueExport: { status: "done", url: "https://x/1" } });
    expect(screen.queryByText(/Issue を開く/)).toBeNull();
  });

  it("Issue 起票は既定で要約・素材を含めず、チェックした opt-in を choice で渡す（P3）", () => {
    const cb = setup();
    fireEvent.click(screen.getByRole("button", { name: /Issue/ }));
    expect(cb.onExportIssue).toHaveBeenLastCalledWith({
      includeSummary: false,
      includeMaterials: false,
    });

    fireEvent.click(screen.getByLabelText(/会話の要約/));
    fireEvent.click(screen.getByLabelText(/参考資料のサマリ/));
    fireEvent.click(screen.getByRole("button", { name: /Issue/ }));
    expect(cb.onExportIssue).toHaveBeenLastCalledWith({
      includeSummary: true,
      includeMaterials: true,
    });
  });

  it("起票権限が無いとき Issue ボタンを無効化し理由を出す（ADR-0053）", () => {
    setup({ issueDisabledReason: "github not linked" });
    const btn = screen.getByRole("button", { name: /Issue/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/GitHub と連携すると起票できます/)).toBeTruthy();
  });

  it("repo 権限が無いときは対象リポジトリ権限の理由を出す（ADR-0053）", () => {
    setup({ issueDisabledReason: "no repo access" });
    expect(screen.getByText(/対象リポジトリへの権限がありません/)).toBeTruthy();
  });
});
