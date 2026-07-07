// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.fn();
const renderButton = vi.fn();
const prompt = vi.fn();
const disableAutoSelect = vi.fn();

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  window.localStorage.clear();
  initialize.mockClear();
  renderButton.mockClear();
  prompt.mockClear();
  disableAutoSelect.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { google?: unknown }).google;
});

describe("useGoogleAuth ログアウトと auto_select 抑止（cold load レース / P0）", () => {
  it("GIS 未ロード中の signOut 後、GIS 到着時の初期化は auto_select:false かつ disableAutoSelect を発火する", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());
    expect(initialize).not.toHaveBeenCalled();

    act(() => result.current.signOut());

    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
    };
    act(() => result.current.resetButton());

    const lastInit = initialize.mock.calls.at(-1)?.[0] as { auto_select?: boolean } | undefined;
    expect(lastInit?.auto_select).toBe(false);
    expect(disableAutoSelect).toHaveBeenCalled();
  });

  it("明示サインイン（credential 到着）で抑止は解除され、以後の初期化は auto_select:true に戻る", async () => {
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${b64({ alg: "none" })}.${b64({ email: "a@example.com", name: "A" })}.sig`;

    const { useGoogleAuth } = await import("./auth");
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
    };
    const { result } = renderHook(() => useGoogleAuth());

    act(() => result.current.signOut());
    const cb = initialize.mock.calls.at(-1)?.[0] as
      | { callback?: (r: { credential?: string; select_by?: string }) => void }
      | undefined;
    act(() => cb?.callback?.({ credential: jwt, select_by: "btn" }));
    expect(result.current.loggedIn).toBe(true);

    act(() => result.current.resetButton());
    const lastInit = initialize.mock.calls.at(-1)?.[0] as { auto_select?: boolean } | undefined;
    expect(lastInit?.auto_select).toBe(true);
  });
});
