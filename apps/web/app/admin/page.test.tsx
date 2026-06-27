// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
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

import { ApiError, listAdminSessions } from "@/lib/api";
import AdminPage from "./page";

describe("管理画面の認証ゲート（厳密・全画面保護）", () => {
  beforeEach(() => {
    authState.loggedIn = false;
    authState.ready = true;
    authState.devMode = false;
    replace.mockClear();
    push.mockClear();
    authState.signOut.mockClear();
    vi.mocked(listAdminSessions).mockReset().mockResolvedValue([]);
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

  it("401（期限切れ token）の「ログインへ」は signOut して credential を clear する", async () => {
    // loggedIn=true でゲートを通過させ、API が 401 を返す状況を作る。
    authState.loggedIn = true;
    const err = new ApiError(401, "unauthorized");
    // モックの ApiError は status=0 の初期化子を持つため、401 を明示的に上書きする。
    (err as unknown as { status: number }).status = 401;
    vi.mocked(listAdminSessions).mockReset().mockRejectedValue(err);
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText("ログインへ")).toBeTruthy());
    fireEvent.click(screen.getByText("ログインへ"));
    // 期限切れ credential を clear（loggedIn=false）して authGate 経由で再認証へ送る。
    expect(authState.signOut).toHaveBeenCalledTimes(1);
  });

  it("戻るはホーム / へ送る（/login ではない＝戻るループ防止）", async () => {
    authState.loggedIn = true;
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText("管理の間")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(push).toHaveBeenCalledWith("/");
  });
});
