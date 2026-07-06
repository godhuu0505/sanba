// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Product } from "@/lib/api";

// 確認項目カード: 追加/削除の即時保存・最大 10 個の上限・重複無視を検証する。

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

import { ProductCheckItemsCard } from "./ProductCheckItemsCard";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "請求アプリ",
    description: "",
    glossary: [],
    created_at: "2026-07-01T00:00:00+00:00",
    github_repo: null,
    github_branch: null,
    github_commit_sha: null,
    github_index_status: "none",
    role: "owner",
    output_formats: {},
    output_format_defaults: { end_user: "", planner: "", developer: "" },
    check_items: [],
    ...overrides,
  };
}

describe("ProductCheckItemsCard", () => {
  beforeEach(() => {
    updateProduct.mockReset().mockImplementation((_id, patch) =>
      Promise.resolve(product({ check_items: patch.check_items })),
    );
  });
  afterEach(() => cleanup());

  it("追加で check_items の全量置換を即時 PATCH する", async () => {
    const onSaved = vi.fn();
    render(
      <ProductCheckItemsCard product={product({ check_items: ["既存項目"] })} onSaved={onSaved} />,
    );
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "ログイン方式を確認する" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { check_items: ["既存項目", "ログイン方式を確認する"] },
        "id-token",
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("削除で該当項目を除いた全量置換を PATCH する", async () => {
    render(
      <ProductCheckItemsCard
        product={product({ check_items: ["項目A", "項目B"] })}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "項目A を削除" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith("prod-1", { check_items: ["項目B"] }, "id-token"),
    );
  });

  it("登録数カウンタを出し、10 個で入力と追加を畳む（要求仕様: 最大 10 個）", () => {
    const items = Array.from({ length: 10 }, (_, i) => `項目${i}`);
    render(<ProductCheckItemsCard product={product({ check_items: items })} onSaved={vi.fn()} />);
    expect(screen.getByLabelText("確認項目の登録数").textContent).toContain("10 / 10");
    expect((screen.getByLabelText("確認項目を追加") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "確認項目を追加する" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("重複項目は追加せず API も呼ばない", () => {
    render(
      <ProductCheckItemsCard product={product({ check_items: ["既存項目"] })} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "既存項目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it("保存失敗はエラーを表示する", async () => {
    updateProduct.mockRejectedValue(new Error("boom"));
    render(<ProductCheckItemsCard product={product()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "新項目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
