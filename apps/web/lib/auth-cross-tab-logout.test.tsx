// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
});

const mocks = vi.hoisted(() => ({
  fetchSessionMe: vi.fn(),
  revokeSession: vi.fn(async () => undefined),
  exchangeIdToken: vi.fn(),
  fetchAuthNonce: vi.fn(async () => null),
  setAuthNonce: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchSessionMe: mocks.fetchSessionMe,
  revokeSession: mocks.revokeSession,
  exchangeIdToken: mocks.exchangeIdToken,
  fetchAuthNonce: mocks.fetchAuthNonce,
  setAuthNonce: mocks.setAuthNonce,
}));

vi.mock("./googleDrive", () => ({
  isDriveConfigured: () => false,
}));

import { AuthProvider, LOGOUT_CHANNEL, useAuth } from "./auth";

const profile = {
  sub: "google-sub-1",
  email: "user@example.com",
  email_verified: true,
  name: "Test",
  expires_at: 9_999_999_999,
  idle_expires_at: 9_999_999_999,
};

describe("クロスタブログアウト（ADR-0030 / ADR-0060 サーバセッション経路）", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    mocks.fetchSessionMe.mockResolvedValue(profile);
    mocks.revokeSession.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "";
  });

  it("signOut は revokeSession を呼びローカル state をクリアする", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loggedIn).toBe(true));

    await act(async () => {
      await result.current.signOut();
    });

    expect(mocks.revokeSession).toHaveBeenCalledTimes(1);
    expect(result.current.loggedIn).toBe(false);
    expect(result.current.profile).toBeNull();
  });

  it("signOut({ broadcast: false }) でも revokeSession は同じく呼ばれる（サーバ側 revoke は失わない）", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loggedIn).toBe(true));

    await act(async () => {
      await result.current.signOut({ broadcast: false });
    });

    expect(mocks.revokeSession).toHaveBeenCalledTimes(1);
    expect(result.current.loggedIn).toBe(false);
  });

  it("非 dev モードでは BroadcastChannel(LOGOUT_CHANNEL) を購読する", () => {
    const OriginalBC = globalThis.BroadcastChannel;
    const names: string[] = [];
    class Tracked extends OriginalBC {
      constructor(name: string) {
        super(name);
        names.push(name);
      }
    }
    (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      Tracked as typeof BroadcastChannel;
    try {
      render(
        <AuthProvider>
          <div>x</div>
        </AuthProvider>,
      );
      expect(names).toContain(LOGOUT_CHANNEL);
    } finally {
      (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = OriginalBC;
    }
  });

});
