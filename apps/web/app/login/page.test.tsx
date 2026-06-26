// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "./page";

// dev モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定）では GIS 無しに全フローを駆動できる。
// 12（本人確認中）の自動遷移はフェイクタイマーで進める。
describe("LoginPage ログイン/ログアウト フロー（dev モード）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
    replace.mockClear();
    window.history.replaceState({}, "", "/login");
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

  it("?next= 付きで来てログインすると、welcome 後に元の遷移先へ復帰する", () => {
    window.history.replaceState({}, "", "/login?next=%2F%E5%95%8F%E7%AD%94");
    render(<LoginPage />);
    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    // welcome 中はまだ復帰しない
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(replace).toHaveBeenCalledWith("/問答");
  });

  it("next が無いときは復帰リダイレクトしない（13 に留まる）", () => {
    render(<LoginPage />);
    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
      vi.advanceTimersByTime(1100);
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"])(
    "オリジン外/危険スキームの next=%s は復帰せず破棄する（オープンリダイレクト/XSS 防止）",
    (evil) => {
      window.history.replaceState({}, "", `/login?next=${encodeURIComponent(evil)}`);
      render(<LoginPage />);
      // 同一オリジンの相対パスと同じ駆動（click → タイマー経過）でも、危険な next は無視される。
      act(() => {
        fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
      });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(replace).not.toHaveBeenCalled();
      // 13（ログイン済み導線）に留まる。
      expect(screen.getByText((c) => c.includes("ログイン中:"))).toBeTruthy();
    },
  );
});
