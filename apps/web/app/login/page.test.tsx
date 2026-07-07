// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import { AuthProvider } from "@/lib/auth";
import LoginPage from "./page";

const renderLogin = () => render(<LoginPage />, { wrapper: AuthProvider });

describe("LoginPage ログイン/ログアウト フロー（dev モード）", () => {
  afterEach(() => {
    cleanup();
    replace.mockClear();
    window.history.replaceState({}, "", "/login");
  });

  it("未認証は中央 1 カラム: SANBA 見出し＋タグライン＋ログインボタン（サインアップ/ヘッダー/2 ペイン/入力欄は無い）", () => {
    renderLogin();

    // main ランドマークを持ち "ログイン" と名付ける（見出しがブランド名でも画面の目的が伝わる）。
    expect(screen.getByRole("main", { name: "ログイン" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SANBA" })).toBeTruthy();
    expect(screen.getByText("解像度高く、要件を生み出す")).toBeTruthy();
    expect(screen.getByText("開発用ログイン（bypass）")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "今すぐサインアップ" })).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
  });

  it("ログインすると本人確認の中間画面を挟まず即ホーム / へ送る", () => {
    renderLogin();

    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("?next= 付きで来てログインすると、元の遷移先へ復帰する", () => {
    window.history.replaceState({}, "", "/login?next=%2F%E5%95%8F%E7%AD%94");
    renderLogin();

    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    expect(replace).toHaveBeenCalledWith("/問答");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"])(
    "オリジン外/危険スキームの next=%s は破棄し、既定のホーム / へ送る（オープンリダイレクト/XSS 防止）",
    (evil) => {
      window.history.replaceState({}, "", `/login?next=${encodeURIComponent(evil)}`);
      renderLogin();

      act(() => {
        fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
      });
      expect(replace).toHaveBeenCalledWith("/");
      expect(replace).not.toHaveBeenCalledWith(evil);
    },
  );

  it("?loggedOut=1 で来ると挨拶を挟まずクリーンなログイン画面を出し、再ログインでホームへ送る", () => {
    window.history.replaceState({}, "", "/login?loggedOut=1");
    renderLogin();

    expect(screen.getByRole("heading", { name: "SANBA" })).toBeTruthy();
    expect(screen.getByText("開発用ログイン（bypass）")).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/");

    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    expect(replace).toHaveBeenCalledWith("/");
  });
});
