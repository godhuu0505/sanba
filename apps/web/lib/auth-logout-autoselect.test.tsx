// @vitest-environment jsdom
// 回帰テスト（P0）: 明示ログアウト（/login?loggedOut=1）が、GIS 未ロード中の signOut では
// 無音で無効化されるバグの防止。cold/フルロードでは AuthProvider が新規マウントされ、
// signOut() の時点で window.google が未定義なため resetLocalAuth の disableAutoSelect() が
// 空振りする。その後 GIS がロードされ auto_select が働くと credential が復元され、ログアウト
// したはずが静かに再ログイン→ホームへ bounce する。
// 対策: signOut は auto_select 抑止の意図を保持し、GIS が後から利用可能になった初期化でも
// auto_select:false で立ち上げ、disableAutoSelect() を確実に発火させる。
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
    // cold load を模す: window.google 未定義でマウント（初期化は script-load 待ちで未発火）。
    const { result } = renderHook(() => useGoogleAuth());
    expect(initialize).not.toHaveBeenCalled();

    // window.google 未定義のまま signOut（disableAutoSelect は空振り＝抑止意図だけ残る）。
    act(() => result.current.signOut());

    // GIS が後から利用可能になり、bootstrap effect を再実行（idNow 同期パス）。
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
    };
    act(() => result.current.resetButton());

    // 直近の初期化は auto_select を無効化している（静かな再取得を試みない）。
    const lastInit = initialize.mock.calls.at(-1)?.[0] as { auto_select?: boolean } | undefined;
    expect(lastInit?.auto_select).toBe(false);
    // g_state 永続化のため disableAutoSelect も発火する（次回リロードでも復元しない）。
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

    // ログアウト → 抑止。
    act(() => result.current.signOut());
    // ユーザーが明示的にサインイン（select_by はボタン経由）。
    const cb = initialize.mock.calls.at(-1)?.[0] as
      | { callback?: (r: { credential?: string; select_by?: string }) => void }
      | undefined;
    act(() => cb?.callback?.({ credential: jwt, select_by: "btn" }));
    expect(result.current.loggedIn).toBe(true);

    // 再初期化（resetButton）では auto_select が復活する（正常時のリロード復元を壊さない）。
    act(() => result.current.resetButton());
    const lastInit = initialize.mock.calls.at(-1)?.[0] as { auto_select?: boolean } | undefined;
    expect(lastInit?.auto_select).toBe(true);
  });
});
