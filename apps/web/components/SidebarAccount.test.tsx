// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

import { SidebarAccount } from "./SidebarAccount";

const profile = {
  email: "go@sanba.local",
  name: "産婆",
  picture: "https://lh3.googleusercontent.com/a/portrait",
};

describe("SidebarAccount（サイドメニュー下部のアカウント）", () => {
  beforeEach(() => push.mockClear());
  afterEach(() => cleanup());

  function open() {
    fireEvent.click(screen.getByRole("button", { name: "アカウントメニュー" }));
  }

  it("メールアドレスとアカウントアイコン（Google画像）を表示する", () => {
    const { container } = render(<SidebarAccount profile={profile} />);
    expect(screen.getAllByText("go@sanba.local").length).toBeGreaterThan(0);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(profile.picture);
  });

  it("picture 未設定ならイニシャルのアバターを出す（フォールバック）", () => {
    const { container } = render(
      <SidebarAccount profile={{ email: "no@sanba.local", name: "無" }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "アカウントメニュー" }).textContent).toContain("無");
  });

  it("クリックでアカウント設定/ログアウトを開く", () => {
    render(<SidebarAccount profile={profile} />);
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    const menu = screen.getByRole("menu", { name: "アカウント" });
    expect(menu).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /アカウント設定/ }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("menuitem", { name: /ログアウト/ })).toBeTruthy();
  });

  it("ログアウト押下で /login?loggedOut=1 に遷移する", () => {
    render(<SidebarAccount profile={profile} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    expect(push).toHaveBeenCalledWith("/login?loggedOut=1");
  });

  it("Escape でメニューを閉じる（a11y）", () => {
    render(<SidebarAccount profile={profile} />);
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("collapsed ではメール文字列を隠しアイコンのみにする", () => {
    render(<SidebarAccount profile={profile} collapsed />);
    const button = screen.getByRole("button", { name: "アカウントメニュー" });
    expect(button.textContent).toBe("");
  });
});
