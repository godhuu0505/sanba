// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

import { AccountMenu } from "./AccountMenu";

const profile = {
  sub: "google-sub-1",
  email: "go@sanba.local",
  email_verified: true,
  name: "産婆",
};

describe("AccountMenu", () => {
  beforeEach(() => {
    push.mockClear();
  });
  afterEach(() => cleanup());

  function open() {
    fireEvent.click(screen.getByRole("button", { name: "アカウントメニュー" }));
  }

  it("初期はメニューを開かない", () => {
    render(<AccountMenu profile={profile} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("アバター押下でメニューを開き、アカウント設定/ログアウトの2項目を出す", () => {
    render(<AccountMenu profile={profile} />);
    open();
    expect(screen.getByRole("menu")).toBeTruthy();
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    expect(items[0]).toMatch(/アカウント設定/);
    expect(items[1]).toMatch(/ログアウト/);
    expect(screen.getByText(/go@sanba\.local/)).toBeTruthy();
  });

  it("アカウント設定は /settings へ遷移する menuitem（ラベル＋アイコン併記 / ADR-0017）", () => {
    render(<AccountMenu profile={profile} />);
    open();
    const settings = screen.getByRole("menuitem", { name: /アカウント設定/ });
    expect(settings.getAttribute("href")).toBe("/settings");
  });

  it("hideSettings でアカウント設定項目を畳む（設定画面での自己リンク回避）", () => {
    render(<AccountMenu profile={profile} hideSettings />);
    open();
    expect(screen.queryByRole("menuitem", { name: /アカウント設定/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
  });

  it("背景（scrim）クリックで閉じる", () => {
    render(<AccountMenu profile={profile} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "閉じる（背景）" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ログアウトは /login?loggedOut=1 への遷移に一本化する（signOut は遷移先で実行）", () => {
    render(<AccountMenu profile={profile} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    expect(push).toHaveBeenCalledWith("/login?loggedOut=1");
  });
});
