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

  // ── 91/92 の画面分離（#220 / Figma 73:8・73:9）──────────────────
  it("91 一覧に主 CTA を出し、作成カードは常時展開しない（アコーディオン廃止）", async () => {
    authState.loggedIn = true;
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText("管理の間")).toBeTruthy());
    expect(screen.getByRole("button", { name: "＋ セッションを興す" })).toBeTruthy();
    // 92 専用画面へ遷移するまで作成カードは出さない。
    expect(screen.queryByText("新たな問答を興す")).toBeNull();
    expect(screen.queryByText("セッションを作成")).toBeNull();
  });

  it("CTA 押下で 92「新たな問答を興す」専用画面へ遷移し、戻るで 91 一覧へ戻る", async () => {
    authState.loggedIn = true;
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText("管理の間")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "＋ セッションを興す" }));
    // 92 ヘッダ（Figma 76:38）と作成カードが出る。一覧の「管理の間」は出ない。
    expect(screen.getByText("新たな問答を興す")).toBeTruthy();
    expect(screen.getByText("セッションを作成")).toBeTruthy();
    expect(screen.queryByText("管理の間")).toBeNull();
    // router.push は呼ばず、view 状態だけで遷移する（同一ルート内）。
    expect(push).not.toHaveBeenCalled();
    // 戻るで 91 一覧へ復帰。
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByText("管理の間")).toBeTruthy();
    expect(screen.queryByText("新たな問答を興す")).toBeNull();
  });

  it("92 招く役割の既定は『企画(PdM)』単一（Figma 76:46 / 監査 B-3 #16）", async () => {
    authState.loggedIn = true;
    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText("管理の間")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "＋ セッションを興す" }));
    // 選択状態は aria-pressed で表す（● マーカーは aria-hidden）。企画(PdM) のみ pressed。
    expect(screen.getByRole("button", { name: "企画(PdM)", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "エンジニア", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "顧客", pressed: false })).toBeTruthy();
  });
});
