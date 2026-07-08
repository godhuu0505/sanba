// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Product } from "@/lib/api";

const authState = {
  credential: "id-token",
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
  useParams: () => ({ id: "prod-1" }),
}));

const fetchProduct = vi.fn();
const updateProduct = vi.fn();
const deleteProduct = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchProduct: (...args: unknown[]) => fetchProduct(...args),
    updateProduct: (...args: unknown[]) => updateProduct(...args),
    deleteProduct: (...args: unknown[]) => deleteProduct(...args),
    fetchGithubRepos: () => Promise.resolve({ enabled: false, repos: [], default: null }),
    listProductInvites: () => Promise.resolve([]),
    fetchProductMembers: () => Promise.resolve([]),
    listMemberInvites: () => Promise.resolve([]),
  };
});

import ProductDetailPage from "./page";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "請求アプリ",
    slug: "billing-app",
    description: "経費精算",
    glossary: ["請求書一覧"],
    created_at: "2026-07-01T00:00:00+00:00",
    github_repo: null,
    github_branch: null,
    github_commit_sha: null,
    github_index_status: "none",
    role: "owner" as const,
    output_formats: {},
    output_format_defaults: {
      end_user: "# 利用者向けデフォルト",
      planner: "# 企画者向けデフォルト",
      developer: "# 開発者向けデフォルト",
    },
    check_items: [],
    check_items_limit: 10,
    check_point_defaults: {},
    ...overrides,
  };
}

describe("アプリ詳細画面（ADR-0031 / FR-1.2）", () => {
  beforeEach(() => {
    replace.mockClear();
    push.mockClear();
    fetchProduct.mockReset().mockResolvedValue(product());
    updateProduct.mockReset().mockResolvedValue(product({ name: "改名" }));
    deleteProduct.mockReset().mockResolvedValue({ deleted: true });
  });
  afterEach(() => cleanup());

  it("404（不存在・非所有）は「見つかりません」に平す", async () => {
    fetchProduct.mockRejectedValue(new ApiError(404, "not found"));
    render(<ProductDetailPage />);
    expect(await screen.findByText("見つかりません")).toBeTruthy();
    expect(screen.queryByText("基本情報")).toBeNull();
  });

  it("基本情報の保存は PATCH（name/slug/description）を呼ぶ", async () => {
    render(<ProductDetailPage />);
    const nameInput = await screen.findByLabelText("アプリ名（必須）");
    fireEvent.change(nameInput, { target: { value: "改名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { name: "改名", slug: "billing-app", description: "経費精算" },
        "id-token",
      ),
    );
  });

  it("URL キーワードを変更して保存でき、形式違反は API を呼ばず弾く（ADR-0045）", async () => {
    render(<ProductDetailPage />);
    const slugInput = await screen.findByLabelText("URL キーワード（必須）");
    fireEvent.change(slugInput, { target: { value: "Renamed-App" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { name: "請求アプリ", slug: "renamed-app", description: "経費精算" },
        "id-token",
      ),
    );
    updateProduct.mockClear();
    fireEvent.change(slugInput, { target: { value: "bad slug!" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL キーワード");
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it("語彙の追加は即時 PATCH（glossary）を呼ぶ", async () => {
    render(<ProductDetailPage />);
    const input = await screen.findByLabelText("語彙を追加");
    fireEvent.change(input, { target: { value: "取引先" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { glossary: ["請求書一覧", "取引先"] },
        "id-token",
      ),
    );
  });

  it("削除は二段確認で、確定後に一覧へ戻る", async () => {
    render(<ProductDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "削除する…" }));
    expect(deleteProduct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteProduct).toHaveBeenCalledWith("prod-1", "id-token"));
    expect(push).toHaveBeenCalledWith("/products");
  });
});
