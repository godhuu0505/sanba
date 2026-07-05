// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MyMemberInvite } from "@/lib/api";

// アプリ内の招待通知（ADR-0036 決定3）: 招待が無ければ何も出ない・承諾/辞退の API 呼び出し・
// 承諾後の onAccepted フックを検証する。API はモックする。

const authState = { credential: "id-token", loggedIn: true, ready: true, profile: null, devMode: false };
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const fetchMyMemberInvites = vi.fn();
const respondMemberInvite = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchMyMemberInvites: (...args: unknown[]) => fetchMyMemberInvites(...args),
    respondMemberInvite: (...args: unknown[]) => respondMemberInvite(...args),
  };
});

import { MemberInviteNotices } from "./MemberInviteNotices";

function invite(overrides: Partial<MyMemberInvite> = {}): MyMemberInvite {
  return {
    id: "minv-1",
    product_id: "prod-1",
    product_name: "請求アプリ",
    invited_by_email: "owner@example.com",
    created_at: "2026-07-01T00:00:00+00:00",
    expires_at: "2026-07-15T00:00:00+00:00",
    ...overrides,
  };
}

describe("MemberInviteNotices（招待のアプリ内通知 / ADR-0036）", () => {
  beforeEach(() => {
    fetchMyMemberInvites.mockReset().mockResolvedValue([]);
    respondMemberInvite.mockReset().mockResolvedValue({ status: "accepted", product_id: "prod-1" });
  });
  afterEach(() => cleanup());

  it("招待が無ければ何も描画しない", async () => {
    const { container } = render(<MemberInviteNotices />);
    await waitFor(() => expect(fetchMyMemberInvites).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("招待があれば通知カードを出し、承諾で respond と onAccepted を呼ぶ", async () => {
    fetchMyMemberInvites.mockResolvedValueOnce([invite()]).mockResolvedValue([]);
    const onAccepted = vi.fn();
    render(<MemberInviteNotices onAccepted={onAccepted} />);
    await screen.findByText("招待が届いています");
    expect(screen.getByText(/請求アプリ/)).toBeTruthy();
    expect(screen.getByText(/owner@example.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "請求アプリ への招待を承諾" }));
    await waitFor(() =>
      expect(respondMemberInvite).toHaveBeenCalledWith("minv-1", "accept", "id-token"),
    );
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith("prod-1"));
  });

  it("辞退は decline で呼び、onAccepted は呼ばない", async () => {
    fetchMyMemberInvites.mockResolvedValueOnce([invite()]).mockResolvedValue([]);
    respondMemberInvite.mockResolvedValue({ status: "declined", product_id: "prod-1" });
    const onAccepted = vi.fn();
    render(<MemberInviteNotices onAccepted={onAccepted} />);
    await screen.findByText("招待が届いています");
    fireEvent.click(screen.getByRole("button", { name: "請求アプリ への招待を辞退" }));
    await waitFor(() =>
      expect(respondMemberInvite).toHaveBeenCalledWith("minv-1", "decline", "id-token"),
    );
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
