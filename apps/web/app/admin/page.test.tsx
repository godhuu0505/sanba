// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 厳密な認証ゲート（全画面保護）を検証する。未ログイン（real モード）は /login?next=/admin へ。
// 重い依存（lib/api / GIS）はモックし、ゲートのリダイレクト挙動に集中する。

const authState = {
  credential: null as string | null,
  profile: null as { name?: string } | null,
  loggedIn: false,
  ready: true,
  devMode: false,
  buttonRef: { current: null },
  devSignIn: vi.fn(),
  signOut: vi.fn(),
  resetButton: vi.fn(),
};
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  createSession: vi.fn(),
  listAdminSessions: vi.fn(async () => []),
  listSessionRequirements: vi.fn(async () => []),
  updateRequirement: vi.fn(),
}));

import AdminPage from "./page";

describe("管理画面の認証ゲート（厳密・全画面保護）", () => {
  beforeEach(() => {
    authState.loggedIn = false;
    authState.ready = true;
    authState.devMode = false;
    replace.mockClear();
  });
  afterEach(() => cleanup());

  it("real モードで未ログインなら /login?next=/admin へリダイレクトし管理UIを描画しない", () => {
    render(<AdminPage />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/admin")}`);
    expect(screen.queryByText("管理の間")).toBeNull();
  });

  it("認証解決前（ready=false）はリダイレクトせず何も描かない", () => {
    authState.ready = false;
    render(<AdminPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("管理の間")).toBeNull();
  });
});
