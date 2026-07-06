// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Product } from "@/lib/api";

// 出力フォーマットカード: audience タブの切り替え・全量置換での保存・
// 「デフォルト使用中/登録済み」の出し分け・デフォルトへ戻すを検証する。

const authState = { credential: "id-token", loggedIn: true, ready: true, profile: null };
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const updateProduct = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    updateProduct: (...args: unknown[]) => updateProduct(...args),
  };
});

import { ProductOutputFormatsCard } from "./ProductOutputFormatsCard";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "請求アプリ",
    slug: "billing-app",
    description: "",
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

describe("ProductOutputFormatsCard", () => {
  beforeEach(() => {
    updateProduct.mockReset().mockImplementation((_id, patch) =>
      Promise.resolve(product({ output_formats: patch.output_formats })),
    );
  });
  afterEach(() => cleanup());

  it("利用者/企画者/開発者の3タブを出し、既定は利用者向け", () => {
    render(<ProductOutputFormatsCard product={product()} onSaved={vi.fn()} />);
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent ?? "");
    expect(tabs).toEqual(["利用者向け", "企画者向け", "開発者向け"]);
    expect(screen.getByRole("tab", { name: "利用者向け" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("未登録は「デフォルト使用中」を示し、デフォルトのテンプレートを参照できる", () => {
    render(<ProductOutputFormatsCard product={product()} onSaved={vi.fn()} />);
    expect(screen.getByText("デフォルト使用中")).toBeTruthy();
    expect(screen.getByText("# 利用者向けデフォルト")).toBeTruthy();
  });

  it("登録済みの audience は「登録済み」を示しテンプレートを編集欄に出す", () => {
    render(
      <ProductOutputFormatsCard
        product={product({ output_formats: { end_user: "# 独自" } })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText("登録済み")).toBeTruthy();
    expect(
      (screen.getByLabelText("利用者向け出力フォーマット") as HTMLTextAreaElement).value,
    ).toBe("# 独自");
  });

  it("保存は3 audience の全量置換で PATCH する（1対象1フォーマット）", async () => {
    const onSaved = vi.fn();
    render(<ProductOutputFormatsCard product={product()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("tab", { name: "開発者向け" }));
    fireEvent.change(screen.getByLabelText("開発者向け出力フォーマット"), {
      target: { value: "# 開発者向け独自\n{{requirements}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "開発者向けを保存する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        {
          output_formats: {
            end_user: "",
            planner: "",
            developer: "# 開発者向け独自\n{{requirements}}",
          },
        },
        "id-token",
      ),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText("保存しました")).toBeTruthy();
  });

  it("「デフォルトに戻す」は空値で保存する（サーバ側で登録が消える）", async () => {
    render(
      <ProductOutputFormatsCard
        product={product({ output_formats: { end_user: "# 独自" } })}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "デフォルトに戻す" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { output_formats: { end_user: "", planner: "", developer: "" } },
        "id-token",
      ),
    );
  });

  it("保存失敗はエラーを表示する", async () => {
    updateProduct.mockRejectedValue(new Error("boom"));
    render(<ProductOutputFormatsCard product={product()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "利用者向けを保存する" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
