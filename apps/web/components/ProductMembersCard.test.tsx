// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProductMember, ProductMemberInvite } from "@/lib/api";

// メンバー管理カード（ADR-0036）: 招待の発行・重複エラーの出し分け・メンバー削除・
// canManage=false（メンバー閲覧）で管理操作が出ないことを検証する。API はモックし、
// UI の振る舞い（何をどのパラメータで呼ぶか）に集中する。

const authState = { credential: "id-token", loggedIn: true, ready: true, profile: null };
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const fetchProductMembers = vi.fn();
const listMemberInvites = vi.fn();
const createMemberInvite = vi.fn();
const removeProductMember = vi.fn();
const revokeMemberInvite = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchProductMembers: (...args: unknown[]) => fetchProductMembers(...args),
    listMemberInvites: (...args: unknown[]) => listMemberInvites(...args),
    createMemberInvite: (...args: unknown[]) => createMemberInvite(...args),
    removeProductMember: (...args: unknown[]) => removeProductMember(...args),
    revokeMemberInvite: (...args: unknown[]) => revokeMemberInvite(...args),
  };
});

import { memberInviteUrl, ProductMembersCard } from "./ProductMembersCard";

function member(overrides: Partial<ProductMember> = {}): ProductMember {
  return {
    sub: "sub-1",
    email: "taro@example.com",
    display_name: "太郎",
    created_at: "2026-07-01T00:00:00+00:00",
    ...overrides,
  };
}

function invite(overrides: Partial<ProductMemberInvite> = {}): ProductMemberInvite {
  return {
    id: "minv-1",
    email: "hanako@example.com",
    status: "pending",
    created_at: "2026-07-01T00:00:00+00:00",
    expires_at: "2026-07-15T00:00:00+00:00",
    invited_by_email: "owner@example.com",
    token: "tok.sig",
    ...overrides,
  };
}

describe("ProductMembersCard（メンバー管理 / ADR-0036）", () => {
  beforeEach(() => {
    fetchProductMembers.mockReset().mockResolvedValue([]);
    listMemberInvites.mockReset().mockResolvedValue([]);
    createMemberInvite.mockReset().mockResolvedValue(invite());
    removeProductMember.mockReset().mockResolvedValue({ removed: true });
    revokeMemberInvite.mockReset().mockResolvedValue(invite({ status: "revoked" }));
  });
  afterEach(() => cleanup());

  it("memberInviteUrl は /member-invites/{token} の URL を組む", () => {
    expect(memberInviteUrl("abc.def", "https://youken.sanba.net")).toBe(
      "https://youken.sanba.net/member-invites/abc.def",
    );
  });

  it("メールアドレスを入力して招待できる", async () => {
    render(<ProductMembersCard productId="prod-1" canManage />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "hanako@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待する/ }));
    await waitFor(() =>
      expect(createMemberInvite).toHaveBeenCalledWith("prod-1", "hanako@example.com", "id-token"),
    );
  });

  it("重複（409）は「既にメンバーか招待済み」の文言を出す", async () => {
    const err = Object.assign(new Error("409"), { status: 409 });
    createMemberInvite.mockRejectedValue(err);
    render(<ProductMembersCard productId="prod-1" canManage />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "hanako@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待する/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("既にメンバーか、招待済み"),
    );
  });

  it("メンバーを外せる", async () => {
    fetchProductMembers.mockResolvedValue([member()]);
    render(<ProductMembersCard productId="prod-1" canManage />);
    const removeButton = await screen.findByRole("button", {
      name: "taro@example.com を外す",
    });
    fireEvent.click(removeButton);
    await waitFor(() =>
      expect(removeProductMember).toHaveBeenCalledWith("prod-1", "sub-1", "id-token"),
    );
  });

  it("保留中の招待は取り消せる", async () => {
    listMemberInvites.mockResolvedValue([invite()]);
    render(<ProductMembersCard productId="prod-1" canManage />);
    const revokeButton = await screen.findByRole("button", { name: "招待を取り消す" });
    fireEvent.click(revokeButton);
    await waitFor(() =>
      expect(revokeMemberInvite).toHaveBeenCalledWith("prod-1", "minv-1", "id-token"),
    );
  });

  it("canManage=false では招待フォーム・削除を出さず、招待一覧 API も呼ばない", async () => {
    fetchProductMembers.mockResolvedValue([member()]);
    render(<ProductMembersCard productId="prod-1" canManage={false} />);
    await screen.findByText(/taro@example.com/);
    expect(screen.queryByLabelText("招待するメールアドレス")).toBeNull();
    expect(screen.queryByRole("button", { name: /を外す/ })).toBeNull();
    expect(listMemberInvites).not.toHaveBeenCalled();
  });
});
