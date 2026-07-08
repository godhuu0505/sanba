// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
  credential: null as string | null,
  profile: null as { name?: string; email?: string; picture?: string } | null,
  loggedIn: false,
  ready: true,
  devMode: false,
  buttonRef: { current: null },
  devSignIn: vi.fn(),
  signOut: vi.fn(),
  resetButton: vi.fn(),
};
vi.mock("@/lib/auth", () => ({
  useAuth: () => authState,
  useAuthOptional: () => authState,
}));

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
}));

import SettingsPage from "./page";

describe("アカウント設定画面（#227）", () => {
  beforeEach(() => {
    authState.loggedIn = false;
    authState.ready = true;
    authState.devMode = false;
    authState.profile = null;
    replace.mockClear();
    push.mockClear();
  });
  afterEach(() => cleanup());

  it("real モードで未ログインなら /login?next=/settings へリダイレクトし設定UIを描画しない", () => {
    render(<SettingsPage />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/settings")}`);
    expect(screen.queryByText("プロフィール")).toBeNull();
  });

  it("認証解決前（ready=false）はリダイレクトせず何も描かない", () => {
    authState.ready = false;
    render(<SettingsPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("プロフィール")).toBeNull();
  });

  it("ログイン済みならプロフィール（名前/メール）と保持日数を表示する", () => {
    authState.loggedIn = true;
    authState.profile = { name: "産婆", email: "go@sanba.local" };
    render(<SettingsPage />);
    expect(screen.getByText("アカウント設定")).toBeTruthy();
    expect(screen.getAllByText("産婆").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("go@sanba.local").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/最大 30 日/).length).toBeGreaterThanOrEqual(1);
  });

  it("ログアウトは /login?loggedOut=1 への遷移に一本化する（signOut は遷移先で実行）", () => {
    authState.loggedIn = true;
    authState.profile = { name: "産婆", email: "go@sanba.local" };
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(push).toHaveBeenCalledWith("/login?loggedOut=1");
  });
});
