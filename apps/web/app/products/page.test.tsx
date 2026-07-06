// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Product } from "@/lib/api";

// アプリ管理（一覧・登録 / FR-1.1）: 認証ゲート・一覧表示・登録 → 詳細遷移・空名の 400 相当を検証。

const authState = {
  credential: null as string | null,
  profile: null as { name?: string; email?: string } | null,
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

const createProduct = vi.fn();
const fetchMyProducts = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createProduct: (...args: unknown[]) => createProduct(...args),
    fetchMyProducts: (...args: unknown[]) => fetchMyProducts(...args),
  };
});

import ProductsPage from "./page";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "請求アプリ",
    slug: "billing-app",
    description: "経費精算",
    glossary: [],
    created_at: "2026-07-01T00:00:00+00:00",
    github_repo: null,
    github_branch: null,
    github_commit_sha: null,
    github_index_status: "none",
    role: "owner",
    output_formats: {},
    output_format_defaults: {
      end_user: "# 利用者向けデフォルト",
      planner: "# 企画者向けデフォルト",
      developer: "# 開発者向けデフォルト",
    },
    check_items: [],
    check_items_limit: 10,
    ...overrides,
  };
}

describe("アプリ管理画面（ADR-0031 / FR-1.1）", () => {
  beforeEach(() => {
    authState.loggedIn = false;
    authState.ready = true;
    replace.mockClear();
    push.mockClear();
    createProduct.mockReset().mockResolvedValue(product());
    fetchMyProducts.mockReset().mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("未ログインなら /login?next=/products へリダイレクトし UI を描画しない", () => {
    render(<ProductsPage />);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/products")}`);
    expect(screen.queryByText("アプリを登録")).toBeNull();
  });

  it("ログイン済みなら自分のアプリ一覧を表示する（説明と repo を併記）", async () => {
    authState.loggedIn = true;
    fetchMyProducts.mockResolvedValue([
      product(),
      product({ id: "prod-2", name: "在庫アプリ", description: "", github_repo: "octo/demo" }),
    ]);
    render(<ProductsPage />);
    expect(await screen.findByText("請求アプリ")).toBeTruthy();
    expect(screen.getByText("在庫アプリ")).toBeTruthy();
    expect(screen.getByText(/説明なし ・ octo\/demo/)).toBeTruthy();
  });

  it("登録すると詳細（/products/{id}）へ遷移する。前後空白は落とし slug は小文字へ正規化する", async () => {
    authState.loggedIn = true;
    render(<ProductsPage />);
    fireEvent.change(screen.getByLabelText("アプリ名（必須）"), {
      target: { value: "  新アプリ  " },
    });
    fireEvent.change(screen.getByLabelText("URL キーワード（必須）"), {
      target: { value: "  New-App  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /登録する/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/prod-1"));
    expect(createProduct).toHaveBeenCalledWith("新アプリ", "new-app", "", null);
  });

  it("アプリ名が空（空白のみ）なら API を呼ばずエラーを出す", async () => {
    authState.loggedIn = true;
    render(<ProductsPage />);
    fireEvent.change(screen.getByLabelText("アプリ名（必須）"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /登録する/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("URL キーワードが形式違反・予約語なら API を呼ばずエラーを出す（ADR-0045）", async () => {
    authState.loggedIn = true;
    render(<ProductsPage />);
    fireEvent.change(screen.getByLabelText("アプリ名（必須）"), { target: { value: "新アプリ" } });
    fireEvent.change(screen.getByLabelText("URL キーワード（必須）"), {
      target: { value: "bad slug!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /登録する/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL キーワード");
    // 予約語（web の既存ルート）もサーバー往復なしでその場で弾く。
    fireEvent.change(screen.getByLabelText("URL キーワード（必須）"), {
      target: { value: "products" },
    });
    fireEvent.click(screen.getByRole("button", { name: /登録する/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL キーワード");
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("slug 重複（409）は使用済みの旨をエラー表示する（ADR-0045）", async () => {
    authState.loggedIn = true;
    createProduct.mockRejectedValueOnce(new ApiError(409, "POST /api/products failed: 409"));
    render(<ProductsPage />);
    fireEvent.change(screen.getByLabelText("アプリ名（必須）"), { target: { value: "新アプリ" } });
    fireEvent.change(screen.getByLabelText("URL キーワード（必須）"), {
      target: { value: "dup-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: /登録する/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("既に使われています");
    expect(push).not.toHaveBeenCalled();
  });
});
