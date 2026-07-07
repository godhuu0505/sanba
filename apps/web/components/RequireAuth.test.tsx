// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// next/navigation の useRouter をモックして replace 呼び出しを検証する。
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import { RequireAuth } from "./RequireAuth";

describe("RequireAuth（認証ゲート / 未ログイン→/login リダイレクト）", () => {
  afterEach(() => {
    cleanup();
    replace.mockClear();
  });

  it("認証解決前（ready=false）は子を描画せず、リダイレクトせず中立スプラッシュを出す", () => {
    render(
      <RequireAuth ready={false} loggedIn={false} next="/">
        <div>secret</div>
      </RequireAuth>,
    );
    expect(screen.queryByText("secret")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    // 復元を待つ間は空白ではなく中立のブランドスプラッシュを見せる（ADR-0052。ログインし直して
    // いるように見せない）。auth 側はヒントありで最大 ~8s 復元を待つ。
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();
  });

  it("未ログイン確定（ready=true, loggedIn=false）は /login?next= へリダイレクトし子を出さない", () => {
    render(
      <RequireAuth ready loggedIn={false} next="/問答">
        <div>secret</div>
      </RequireAuth>,
    );
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/問答")}`);
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("ログイン済み（ready=true, loggedIn=true）は子を描画し、リダイレクトしない", () => {
    render(
      <RequireAuth ready loggedIn next="/">
        <div>secret</div>
      </RequireAuth>,
    );
    expect(screen.getByText("secret")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
