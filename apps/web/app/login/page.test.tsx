// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "./page";

// dev モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定）では GIS 無しに全フローを駆動できる。
// 12（本人確認中）の自動遷移はフェイクタイマーで進める。
describe("LoginPage ログイン/ログアウト フロー（dev モード）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
  });

  it("11 → 12 → 13 → 14 → 11 を一巡する", () => {
    render(<LoginPage />);

    // 11 未認証
    expect(screen.getByText("問答の間へ、ようこそ")).toBeTruthy();
    const bypass = screen.getByText("開発用ログイン（bypass）");

    // 11 → 12 サインイン中
    act(() => {
      fireEvent.click(bypass);
    });
    expect(screen.getByText("Google アカウントを確認しています")).toBeTruthy();

    // 12 → 13 ログイン済み（タイマー経過で自動遷移）
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText((c) => c.includes("ログイン中:"))).toBeTruthy();
    expect(screen.getByText("🎙️ インタビューを始める").getAttribute("href")).toBe("/");
    expect(screen.getByText("🛠 管理画面へ").getAttribute("href")).toBe("/admin");

    // 13 → 14 ログアウト完了
    act(() => {
      fireEvent.click(screen.getByText("ログアウト"));
    });
    expect(screen.getByText("おつかれさまでした")).toBeTruthy();

    // 14 → 11 再ログイン
    act(() => {
      fireEvent.click(screen.getByText("再びログインする"));
    });
    expect(screen.getByText("問答の間へ、ようこそ")).toBeTruthy();
  });
});
