// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
  credential: "id-token" as string | null,
  profile: null,
  loggedIn: true,
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
const routerMock = { replace, push, refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ slug: "default-app", id: "sess-1" }),
}));

const fetchMyProducts = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchMyProducts: (...args: unknown[]) => fetchMyProducts(...args),
  };
});

import SlugSessionPage from "./page";

describe("会話中セッション URL の直アクセス（/{slug}/sessions/{id} / ADR-0045）", () => {
  beforeEach(() => {
    authState.loggedIn = true;
    replace.mockClear();
    fetchMyProducts.mockReset().mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("slug が本人のアプリに解決できたら /results/{id} へ送る", async () => {
    fetchMyProducts.mockResolvedValueOnce([
      { id: "p0", name: "既定アプリ", slug: "default-app" },
    ]);
    render(<SlugSessionPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/results/sess-1"));
  });

  it("解決できない slug（不存在・権限なし）は複合エラー画面に落とす", async () => {
    fetchMyProducts.mockResolvedValueOnce([{ id: "p9", name: "他人のアプリ", slug: "other" }]);
    render(<SlugSessionPage />);
    expect(
      await screen.findByText("指定された URL が存在しないか、アクセスする権限がありません。"),
    ).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("候補取得の失敗も複合エラーに平す（権限を確認できないまま通さない / fail-closed）", async () => {
    fetchMyProducts.mockRejectedValueOnce(new Error("fetch failed: 500"));
    render(<SlugSessionPage />);
    expect(
      await screen.findByText("指定された URL が存在しないか、アクセスする権限がありません。"),
    ).toBeTruthy();
  });

  it("未ログイン（real モード）は /login?next= へ戻す", () => {
    authState.loggedIn = false;
    render(<SlugSessionPage />);
    expect(replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/default-app/sessions/sess-1")}`,
    );
    expect(fetchMyProducts).not.toHaveBeenCalled();
  });
});
