// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

type MomentListener = (n: {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}) => void;

let capturedCallback: ((res: { credential?: string }) => void) | null = null;
let capturedListener: MomentListener | null = null;

const initialize = vi.fn((config: { callback: (res: { credential?: string }) => void }) => {
  capturedCallback = config.callback;
});
const prompt = vi.fn((listener?: MomentListener) => {
  capturedListener = listener ?? null;
});
const renderButton = vi.fn();
const disableAutoSelect = vi.fn();

const notDisplayed = {
  isNotDisplayed: () => true,
  isSkippedMoment: () => false,
  isDismissedMoment: () => false,
};

function makeJwt(claims: Record<string, unknown> = { email: "a@example.com", name: "A" }): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

async function renderLoginReal() {
  const { AuthProvider } = await import("@/lib/auth");
  const { default: LoginPage } = await import("./page");
  return render(<LoginPage />, { wrapper: AuthProvider });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  capturedCallback = null;
  capturedListener = null;
  initialize.mockClear();
  prompt.mockClear();
  renderButton.mockClear();
  replace.mockClear();
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
  };
  window.history.replaceState({}, "", "/login");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { google?: unknown }).google;
});

describe("LoginPage 直訪・再訪（real モード / ready ゲート）", () => {
  it("認証解決前はサインイン UI を出さず中立スプラッシュ（読み込み中）を出す", async () => {
    await renderLoginReal();

    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();
    expect(screen.queryByText("解像度高く、要件を生み出す")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("静かな再取得（auto_select）でログインが立ったら、中間画面を挟まず即 / へ replace する", async () => {
    await renderLoginReal();

    act(() => capturedCallback?.({ credential: makeJwt() }));

    expect(screen.queryByText("解像度高く、要件を生み出す")).toBeNull();
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("?next= 付きの直訪でも、復元後は next へ即復帰する", async () => {
    window.history.replaceState({}, "", "/login?next=%2Fsettings");
    await renderLoginReal();

    act(() => capturedCallback?.({ credential: makeJwt() }));
    expect(replace).toHaveBeenCalledWith("/settings");
  });

  it("未ログインが確定（One Tap 不表示）したらサインイン UI を出し、GIS ボタンを描画し直す", async () => {
    await renderLoginReal();

    act(() => capturedListener?.(notDisplayed));

    expect(screen.getByRole("heading", { name: "SANBA" })).toBeTruthy();
    expect(screen.getByText("解像度高く、要件を生み出す")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(renderButton).toHaveBeenCalled();
  });
});
