// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

import { AccountMenu } from "./AccountMenu";

const signOut = vi.fn();
const profile = { email: "go@sanba.local", name: "産婆" };

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
    render(<AccountMenu profile={profile} signOut={signOut} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("アバター押下でメニューを開き、管理者画面/ログアウトを出す（アカウント設定は出さない）", () => {
    render(<AccountMenu profile={profile} signOut={signOut} />);
    open();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /管理者画面/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
    expect(screen.queryByText(/アカウント設定/)).toBeNull();
    // ページ側で解決済みの profile をそのまま表示する（別 hook インスタンスを作らない）。
    expect(screen.getByText(/go@sanba\.local/)).toBeTruthy();
  });

  it("hideAdmin で管理者画面項目を畳む", () => {
    render(<AccountMenu profile={profile} signOut={signOut} hideAdmin />);
    open();
    expect(screen.queryByRole("menuitem", { name: /管理者画面/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
  });

  it("背景（scrim）クリックで閉じる", () => {
    render(<AccountMenu profile={profile} signOut={signOut} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ログアウトで（ページ側の）signOut を呼び /login?loggedOut=1 へ送る", () => {
    render(<AccountMenu profile={profile} signOut={signOut} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/login?loggedOut=1");
  });
});
