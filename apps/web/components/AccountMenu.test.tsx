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
    replace.mockClear();
    signOut.mockClear();
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

  it("ログアウトは signOut を待ってから /login へ遷移する（DELETE /api/session を確実に発火させる）", async () => {
    render(<AccountMenu profile={profile} />);
    open();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /ログアウト/ }));
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
    expect(push).not.toHaveBeenCalledWith("/login?loggedOut=1");
  });
});
