// @vitest-environment jsdom
// real モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 設定済み）での /login 直訪・再訪の挙動。
// 「ログインしているのに /login でログイン画面が見える」回帰の防止:
//  - 認証解決前（ready=false）はサインイン UI を出さず「確認中」を出す
//  - 静かな再取得（auto_select）でログインが立ったら、12 の welcome を挟まず即トップへ replace
//  - 未ログインが確定（One Tap 不表示の通知）したらサインイン UI を出す
// CLIENT_ID はモジュール評価時に env を読むため、stubEnv → resetModules → 動的 import で
// real モードに入る（auth-settle.test.tsx と同じ手法）。
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

// 「One Tap を表示できなかった」通知（未ログイン確定のトリガ）。
const notDisplayed = {
  isNotDisplayed: () => true,
  isSkippedMoment: () => false,
  isDismissedMoment: () => false,
};

// 表示用 decodeProfile が base64url を読めるよう、最小の JWT 風文字列を組む。
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
  // window.google を先に与え、setup() の同期パスで initialize/prompt を呼ばせる。
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
  it("認証解決前はサインイン UI を出さず「確認中」を出す", async () => {
    await renderLoginReal();

    expect(screen.getByText("ログイン状態を確認しています…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "サインイン" })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("静かな再取得（auto_select）でログインが立ったら、welcome を挟まず即 / へ replace する", async () => {
    await renderLoginReal();

    act(() => capturedCallback?.({ credential: makeJwt() }));

    // 12（Google アカウントを確認しています）を挟まず、即トップへ。
    expect(screen.queryByText("Google アカウントを確認しています")).toBeNull();
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

    expect(screen.getByRole("heading", { name: "サインイン" })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    // 11 の出現で resetButton → GIS effect が再実行され、装着済みの buttonRef へ描画される。
    expect(renderButton).toHaveBeenCalled();
  });
});
