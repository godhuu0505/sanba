// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "./page";

// dev モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定）では GIS 無しに全フローを駆動できる。
// 12（本人確認中）の自動遷移はフェイクタイマーで進める。13 ナビハブは廃止し、ログイン後は
// ホーム（or ?next）へ replace する。ログアウト挨拶（14）は ?loggedOut=1 で出す。
describe("LoginPage ログイン/ログアウト フロー（dev モード）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
    replace.mockClear();
    window.history.replaceState({}, "", "/login");
  });

  it("11 → 12 → ログイン後はホーム / へ送る（13 ナビハブは無い）", () => {
    render(<LoginPage />);

    // 11 未認証
    expect(screen.getByText("問答の間へ、ようこそ")).toBeTruthy();
    const bypass = screen.getByText("開発用ログイン（bypass）");

    // 11 → 12 サインイン中
    act(() => {
      fireEvent.click(bypass);
    });
    expect(screen.getByText("Google アカウントを確認しています")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();

    // 12 →（タイマー経過で）ホーム / へ遷移。導線カード（13）は出さない。
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(replace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("ようこそ戻られました")).toBeNull();
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

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"])(
    "オリジン外/危険スキームの next=%s は破棄し、既定のホーム / へ送る（オープンリダイレクト/XSS 防止）",
    (evil) => {
      window.history.replaceState({}, "", `/login?next=${encodeURIComponent(evil)}`);
      render(<LoginPage />);
      act(() => {
        fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
      });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      // 危険な next は無視され、evil へは飛ばさず "/" に丸める。
      expect(replace).toHaveBeenCalledWith("/");
      expect(replace).not.toHaveBeenCalledWith(evil);
    },
  );

  it("?loggedOut=1 で来ると 14（おつかれさまでした）を出し、再ログインで 11 へ戻る", () => {
    window.history.replaceState({}, "", "/login?loggedOut=1");
    render(<LoginPage />);

    // 14 ログアウト完了。未ログインのままなのでホームへは送らない。
    expect(screen.getByText("おつかれさまでした")).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/");

    // 14 → 11 再ログイン
    act(() => {
      fireEvent.click(screen.getByText("再びログインする"));
    });
    expect(screen.getByText("問答の間へ、ようこそ")).toBeTruthy();
  });
});
