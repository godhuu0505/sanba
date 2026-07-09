// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const devProfile = {
  sub: "dev-user",
  email: "dev@sanba.local",
  email_verified: true,
  name: "Dev User",
  expires_at: 0,
  idle_expires_at: 0,
};

vi.mock("@/lib/api", () => ({
  fetchSessionMe: vi.fn(async () => null),
  revokeSession: vi.fn(async () => undefined),
  exchangeIdToken: vi.fn(async () => devProfile),
  fetchAuthNonce: vi.fn(async () => null),
  setAuthNonce: vi.fn(),
}));

vi.mock("@/lib/googleDrive", () => ({
  isDriveConfigured: () => false,
}));

import { AuthProvider } from "@/lib/auth";
import LoginPage from "./page";

const renderLogin = () => render(<LoginPage />, { wrapper: AuthProvider });

async function clickDevSignIn(): Promise<void> {
  const btn = await screen.findByText("開発用ログイン（bypass）");
  await act(async () => {
    fireEvent.click(btn);
  });
}

describe("LoginPage ログイン/ログアウト フロー（ADR-0060 サーバセッション + dev モード）", () => {
  afterEach(() => {
    cleanup();
    replace.mockClear();
    window.history.replaceState({}, "", "/login");
  });

  it("未認証は中央 1 カラム: SANBA 見出し＋タグライン＋ログインボタン", async () => {
    renderLogin();

    expect(await screen.findByRole("main", { name: "ログイン" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SANBA" })).toBeTruthy();
    expect(screen.getByText("解像度高く、要件を生み出す")).toBeTruthy();
    expect(screen.getByText("開発用ログイン（bypass）")).toBeTruthy();
  });

  it("ログインすると即ホーム / へ送る", async () => {
    renderLogin();
    await clickDevSignIn();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("?next= 付きで来てログインすると、元の遷移先へ復帰する", async () => {
    window.history.replaceState({}, "", "/login?next=%2F%E5%95%8F%E7%AD%94");
    renderLogin();
    await clickDevSignIn();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/問答"));
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"])(
    "オリジン外/危険スキームの next=%s は破棄し、既定のホーム / へ送る",
    async (evil) => {
      window.history.replaceState({}, "", `/login?next=${encodeURIComponent(evil)}`);
      renderLogin();
      await clickDevSignIn();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
      expect(replace).not.toHaveBeenCalledWith(evil);
    },
  );
});
