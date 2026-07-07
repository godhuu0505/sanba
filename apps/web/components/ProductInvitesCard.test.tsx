// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProductInvite } from "@/lib/api";

const authState = { credential: "id-token", loggedIn: true, ready: true, profile: null };
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const createProductInvite = vi.fn();
const listProductInvites = vi.fn();
const revokeProductInvite = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createProductInvite: (...args: unknown[]) => createProductInvite(...args),
    listProductInvites: (...args: unknown[]) => listProductInvites(...args),
    revokeProductInvite: (...args: unknown[]) => revokeProductInvite(...args),
  };
});

import { inviteUrl, ProductInvitesCard } from "./ProductInvitesCard";

function invite(overrides: Partial<ProductInvite> = {}): ProductInvite {
  return {
    id: "inv-1",
    scope: "developer",
    expires_at: null,
    max_uses: null,
    use_count: 0,
    revoked: false,
    created_at: "2026-07-01T00:00:00+00:00",
    token: "tok.sig",
    ...overrides,
  };
}

describe("ProductInvitesCard（深掘りリンク / FR-1.5）", () => {
  beforeEach(() => {
    createProductInvite.mockReset().mockResolvedValue(invite());
    listProductInvites.mockReset().mockResolvedValue([]);
    revokeProductInvite.mockReset().mockResolvedValue(invite({ revoked: true }));
  });
  afterEach(() => cleanup());

  it("inviteUrl は /join/{token} の URL を組む", () => {
    expect(inviteUrl("abc.def", "https://youken.sanba.net")).toBe(
      "https://youken.sanba.net/join/abc.def",
    );
  });

  it("既定（期限なし・回数上限なし）の発行は ttl/max_uses を API に送らない", async () => {
    render(<ProductInvitesCard productId="prod-1" />);
    fireEvent.click(screen.getByRole("button", { name: /リンクを発行する/ }));
    await waitFor(() => expect(createProductInvite).toHaveBeenCalled());
    expect(createProductInvite).toHaveBeenCalledWith(
      "prod-1",
      { scope: "developer", ttlSeconds: undefined, maxUses: undefined },
      "id-token",
    );
  });

  it("scope/期限/回数を指定して発行できる", async () => {
    render(<ProductInvitesCard productId="prod-1" />);
    fireEvent.change(screen.getByLabelText("対象"), { target: { value: "end_user" } });
    fireEvent.change(screen.getByLabelText("期限"), { target: { value: String(7 * 24 * 3600) } });
    fireEvent.change(screen.getByLabelText("回数上限"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /リンクを発行する/ }));
    await waitFor(() =>
      expect(createProductInvite).toHaveBeenCalledWith(
        "prod-1",
        { scope: "end_user", ttlSeconds: 7 * 24 * 3600, maxUses: 5 },
        "id-token",
      ),
    );
  });

  it("回数上限が不正（0 以下・小数）なら発行せずエラーを出す", async () => {
    render(<ProductInvitesCard productId="prod-1" />);
    fireEvent.change(screen.getByLabelText("回数上限"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /リンクを発行する/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(createProductInvite).not.toHaveBeenCalled();
  });

  it("一覧の「リンクをコピー」は /join/{token} URL をクリップボードへ書く", async () => {
    listProductInvites.mockResolvedValue([invite()]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<ProductInvitesCard productId="prod-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "リンクをコピー" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/tok.sig`),
    );
  });

  it("失効ボタンは revoke API を呼び、失効済みリンクは操作を無効化する", async () => {
    listProductInvites.mockResolvedValue([invite(), invite({ id: "inv-2", revoked: true })]);
    render(<ProductInvitesCard productId="prod-1" />);
    expect(await screen.findByText("失効済み")).toBeTruthy();

    const revokeButtons = screen.getAllByRole("button", { name: "リンクを失効" });
    expect((revokeButtons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(revokeButtons[0]);
    await waitFor(() =>
      expect(revokeProductInvite).toHaveBeenCalledWith("prod-1", "inv-1", "id-token"),
    );
  });
});
