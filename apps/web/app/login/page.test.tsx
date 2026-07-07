// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import { AuthProvider } from "@/lib/auth";
import LoginPage from "./page";

// LoginPage は useAuth() で共有 auth を読むため、AuthProvider 配下で描画する。
const renderLogin = () => render(<LoginPage />, { wrapper: AuthProvider });

// dev モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定）では GIS 無しに全フローを駆動できる。
// ADR-0052（NASHI GEN 準拠のクリーン化）: 中央 1 カラムの最小構成。ログイン後は本人確認の
// 中間画面を挟まず即ホーム（or ?next）へ replace し、ログアウト（?loggedOut=1）は挨拶を
// 挟まずそのままクリーンなログイン画面を出す。
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

    // 廃止したもの: サインアップ導線・上部ヘッダー・左ブランドペイン（2 ペイン）・メール/パスワード欄。
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
    // 「Google アカウントを確認しています」等の中間画面は無い。即トップへ。
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
      // 危険な next は無視され、evil へは飛ばさず "/" に丸める。
      expect(replace).toHaveBeenCalledWith("/");
      expect(replace).not.toHaveBeenCalledWith(evil);
    },
  );

  it("?loggedOut=1 で来ると挨拶を挟まずクリーンなログイン画面を出し、再ログインでホームへ送る", () => {
    window.history.replaceState({}, "", "/login?loggedOut=1");
    renderLogin();

    // 挨拶画面（おつかれさまでした）は廃止。そのままサインイン画面を出し、ホームへは送らない。
    expect(screen.getByRole("heading", { name: "SANBA" })).toBeTruthy();
    expect(screen.getByText("開発用ログイン（bypass）")).toBeTruthy();
    expect(replace).not.toHaveBeenCalledWith("/");

    // 再ログインは通常どおりホームへ送る（loggedOut ガードが解けている）。
    act(() => {
      fireEvent.click(screen.getByText("開発用ログイン（bypass）"));
    });
    expect(replace).toHaveBeenCalledWith("/");
  });
});
