// @vitest-environment jsdom
// #192 回帰: real モードで id.prompt() を呼んだ *だけ* では ready を立てない。
// 通知コールバック（notDisplayed/skipped/dismissed）・credential 到着・タイムアウトの
// いずれかで初めて解決する。これにより auto_select でセッションを静かに復元できる
// ユーザーが、ready=true かつ loggedIn=false の窓で RequireAuth に早期リダイレクト
// される事象を防ぐ（PR #189 Codex 指摘 3476220229）。
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MomentListener = (n: {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}) => void;

let capturedListener: MomentListener | null = null;
let capturedCallback: ((res: { credential?: string }) => void) | null = null;

const initialize = vi.fn((config: { callback: (res: { credential?: string }) => void }) => {
  capturedCallback = config.callback;
});
const renderButton = vi.fn();
// prompt は momentListener を保持するだけ（自動発火させない）= 「通知前」状態を再現する。
const prompt = vi.fn((listener?: MomentListener) => {
  capturedListener = listener ?? null;
});
const disableAutoSelect = vi.fn();

// 解決トリガとなる通知（dismissed = ユーザーが One Tap を閉じた）。
const dismissed = {
  isNotDisplayed: () => false,
  isSkippedMoment: () => false,
  isDismissedMoment: () => true,
};

// 表示用 decodeProfile が base64url を読めるよう、最小の JWT 風文字列を組む。
function makeJwt(claims: Record<string, unknown> = { email: "a@example.com", name: "A" }): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  vi.useFakeTimers();
  // credential 到着でヒントが書かれるため、テスト間で持ち越さない。
  window.localStorage.clear();
  capturedListener = null;
  capturedCallback = null;
  initialize.mockClear();
  prompt.mockClear();
  // window.google を先に与え、setup() の同期パスで initialize/prompt を呼ばせる。
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete (window as unknown as { google?: unknown }).google;
});

describe("useGoogleAuth settle race (#192)", () => {
  it("prompt() 呼び出し直後は ready=false（通知前に解決しない）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(false);
    expect(result.current.loggedIn).toBe(false);
  });

  it("通知（dismissed）を受けて初めて ready=true になる（未ログインのまま）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    expect(result.current.ready).toBe(false);
    act(() => capturedListener?.(dismissed));
    expect(result.current.ready).toBe(true);
    expect(result.current.loggedIn).toBe(false);
  });

  it("通知が来なくてもタイムアウトで ready=true に fallback する", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    expect(result.current.ready).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.ready).toBe(true);
  });

  it("credential 到着で ready=true かつ loggedIn=true（早期リダイレクトの窓を作らない）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    expect(result.current.ready).toBe(false);
    act(() => capturedCallback?.({ credential: makeJwt() }));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.ready).toBe(true);
  });
});

// ログイン痕跡ヒント（AUTH_HINT_KEY）: 「ログイン済みでフルロードすると固定 2.5s の settle が
// One Tap 復元より先に発火し、毎回 /login を経由してから元ページへ戻る」バグの回帰テスト。
// ヒントがあるブラウザでは復元を長めに待ち、保護ページへ直接入れるようにする。
describe("useGoogleAuth ログイン痕跡ヒント（復元待ちの延長）", () => {
  it("credential 到着でヒントが書かれ、signOut で消える", async () => {
    const { useGoogleAuth, AUTH_HINT_KEY } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    act(() => capturedCallback?.({ credential: makeJwt() }));
    expect(window.localStorage.getItem(AUTH_HINT_KEY)).toBe("1");

    act(() => result.current.signOut());
    expect(window.localStorage.getItem(AUTH_HINT_KEY)).toBeNull();
  });

  it("ヒントありでは 2.5s では settle せず、復元（credential 到着）を待てる", async () => {
    const { useGoogleAuth, AUTH_HINT_KEY } = await import("./auth");
    window.localStorage.setItem(AUTH_HINT_KEY, "1");
    const { result } = renderHook(() => useGoogleAuth());

    // 従来の固定値（2.5s）を過ぎても未ログイン確定にしない＝/login への誤送を防ぐ。
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.ready).toBe(false);

    // 遅れて届いた復元をそのまま受けてログイン状態で解決する。
    act(() => capturedCallback?.({ credential: makeJwt() }));
    expect(result.current.loggedIn).toBe(true);
    expect(result.current.ready).toBe(true);
  });

  it("ヒントありでも延長上限で settle し、復元できなければヒントを消す（次回は長待ちしない）", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { useGoogleAuth, AUTH_HINT_KEY } = await import("./auth");
    window.localStorage.setItem(AUTH_HINT_KEY, "1");
    const { result } = renderHook(() => useGoogleAuth());

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.loggedIn).toBe(false);
    expect(window.localStorage.getItem(AUTH_HINT_KEY)).toBeNull();
    expect(info).toHaveBeenCalledWith("[auth] silent restore timed out; clearing auth hint");
    info.mockRestore();
  });

  it("復元済みならタイマー満了でもヒントを消さない（ログイン継続の痕跡を保つ）", async () => {
    const { useGoogleAuth, AUTH_HINT_KEY } = await import("./auth");
    window.localStorage.setItem(AUTH_HINT_KEY, "1");
    renderHook(() => useGoogleAuth());

    act(() => capturedCallback?.({ credential: makeJwt() }));
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(window.localStorage.getItem(AUTH_HINT_KEY)).toBe("1");
  });
});
