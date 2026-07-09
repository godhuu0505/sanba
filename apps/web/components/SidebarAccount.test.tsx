// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
}));

const signOut = vi.fn(async () => undefined);
vi.mock("@/lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    useAuth: () => ({
      profile: null,
      loggedIn: true,
      ready: true,
      devMode: false,
      credential: null,
      buttonRef: { current: null },
      devSignIn: vi.fn(),
      signOut,
      resetButton: vi.fn(),
      driveGranted: null,
      requestDriveAccess: vi.fn(),
      refreshProfile: vi.fn(),
    }),
  };
});

import { SidebarAccount } from "./SidebarAccount";

const profile = {
  sub: "google-sub-1",
  email: "go@sanba.local",
  email_verified: true,
  name: "産婆",
  picture: "https://lh3.googleusercontent.com/a/portrait",
};

describe("SidebarAccount（サイドメニュー下部のアカウント）", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    signOut.mockClear();
  });
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
      <SidebarAccount
        profile={{
          sub: "google-sub-2",
          email: "no@sanba.local",
          email_verified: true,
          name: "無",
        }}
      />,
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

  it("ログアウト押下は signOut を待ってから /login へ遷移する（DELETE /api/session を確実に発火させる）", async () => {
    render(<SidebarAccount profile={profile} />);
    open();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
    expect(push).not.toHaveBeenCalledWith("/login?loggedOut=1");
  });

  it("Escape でメニューを閉じる（a11y）", () => {
    render(<SidebarAccount profile={profile} />);
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
