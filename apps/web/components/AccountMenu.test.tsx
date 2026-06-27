// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

const signOut = vi.fn();
vi.mock("@/lib/auth", () => ({
  useGoogleAuth: () => ({ profile: { email: "go@sanba.local", name: "産婆" }, signOut }),
}));

import { AccountMenu } from "./AccountMenu";

describe("AccountMenu", () => {
  beforeEach(() => {
    push.mockClear();
    signOut.mockClear();
  });
  afterEach(() => cleanup());

  function open() {
    fireEvent.click(screen.getByRole("button", { name: "アカウントメニュー" }));
  }

  it("初期はメニューを開かない", () => {
    render(<AccountMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("アバター押下でメニューを開き、管理者画面/ログアウトを出す（アカウント設定は出さない）", () => {
    render(<AccountMenu />);
    open();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /管理者画面/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
    expect(screen.queryByText(/アカウント設定/)).toBeNull();
    expect(screen.getByText(/go@sanba\.local/)).toBeTruthy();
  });

  it("hideAdmin で管理者画面項目を畳む", () => {
    render(<AccountMenu hideAdmin />);
    open();
    expect(screen.queryByRole("menuitem", { name: /管理者画面/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
  });

  it("背景（scrim）クリックで閉じる", () => {
    render(<AccountMenu />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ログアウトで signOut を呼び /login?loggedOut=1 へ送る", () => {
    render(<AccountMenu />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/login?loggedOut=1");
  });
});
