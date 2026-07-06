// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Product } from "@/lib/api";

// 確認項目カード: 対象タグ付きの追加/削除の即時保存・サーバ供給の上限・重複無視を検証する。

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
    check_items_limit: 10,
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

  it("追加で check_items の全量置換を即時 PATCH する（既定の対象は全員 = null）", async () => {
    const onSaved = vi.fn();
    render(
      <ProductCheckItemsCard
        product={product({ check_items: [{ text: "既存項目", target: null }] })}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "ログイン方式を確認する" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        {
          check_items: [
            { text: "既存項目", target: null },
            { text: "ログイン方式を確認する", target: null },
          ],
        },
        "id-token",
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("対象（利用者/企画者/開発者）を選んで追加できる（ADR-0040）", async () => {
    render(<ProductCheckItemsCard product={product()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("確認項目の対象"), {
      target: { value: "developer" },
    });
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "認証方式" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { check_items: [{ text: "認証方式", target: "developer" }] },
        "id-token",
      ),
    );
  });

  it("各項目に対象ラベルを表示する", () => {
    render(
      <ProductCheckItemsCard
        product={product({
          check_items: [
            { text: "全員項目", target: null },
            { text: "企画項目", target: "planner" },
          ],
        })}
        onSaved={vi.fn()}
      />,
    );
    // セレクタの <option> にも「全員」があるため、リスト行内のラベルはリスト側で検証する。
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("全員");
    expect(rows[0]).toContain("全員項目");
    expect(rows[1]).toContain("企画者");
    expect(rows[1]).toContain("企画項目");
  });

  it("削除で該当項目を除いた全量置換を PATCH する", async () => {
    render(
      <ProductCheckItemsCard
        product={product({
          check_items: [
            { text: "項目A", target: null },
            { text: "項目B", target: "developer" },
          ],
        })}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "項目A を削除" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        { check_items: [{ text: "項目B", target: "developer" }] },
        "id-token",
      ),
    );
  });

  it("サーバ供給の上限（check_items_limit）で入力と追加を畳む", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ text: `項目${i}`, target: null }));
    render(
      <ProductCheckItemsCard
        product={product({ check_items: items, check_items_limit: 3 })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("確認項目の登録数").textContent).toContain("3 / 3");
    expect((screen.getByLabelText("確認項目を追加") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "確認項目を追加する" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("同じ (text, 対象) の重複は追加せず API も呼ばないが、対象違いは追加できる", async () => {
    render(
      <ProductCheckItemsCard
        product={product({ check_items: [{ text: "既存項目", target: null }] })}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "既存項目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    expect(updateProduct).not.toHaveBeenCalled();

    // 対象が違えば別項目として登録できる。
    fireEvent.change(screen.getByLabelText("確認項目の対象"), {
      target: { value: "end_user" },
    });
    fireEvent.change(screen.getByLabelText("確認項目を追加"), {
      target: { value: "既存項目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認項目を追加する" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "prod-1",
        {
          check_items: [
            { text: "既存項目", target: null },
            { text: "既存項目", target: "end_user" },
          ],
        },
        "id-token",
      ),
    );
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
