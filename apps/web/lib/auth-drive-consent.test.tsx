// @vitest-environment jsdom
// Google ドライブ同意（drive.file / ADR-0040）:
// - requestDriveAccess は GIS トークンクライアントで同意を求め、許可でトークン・拒否で null。
// - 有効期限内のトークンは使い回し、同意ポップアップを乱発しない。
// - 明示ログイン（select_by=btn 等）の直後に自動で同意を求める。リロード時の静かな復元
//   （select_by=auto）ではポップアップを出さない（ユーザー操作なしではブロックされるため）。
// - スコープのチェックを外された（drive.file 不許可の）トークンは受け取らない（fail-closed）。
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

type TokenCallback = (res: {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}) => void;
type ErrorCallback = (err: { type?: string; message?: string }) => void;

let tokenCallback: TokenCallback | null = null;
let errorCallback: ErrorCallback | null = null;
let credentialCallback: ((res: { credential?: string; select_by?: string }) => void) | null = null;

const requestAccessToken = vi.fn();
const initTokenClient = vi.fn(
  (config: { callback: TokenCallback; error_callback?: ErrorCallback }) => {
    tokenCallback = config.callback;
    errorCallback = config.error_callback ?? null;
    return { requestAccessToken };
  },
);

function makeJwt(claims: Record<string, unknown> = { email: "a@example.com", name: "A" }): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "12345-abc.apps.googleusercontent.com");
  // Drive 連携が構成済み（Picker API キーあり）の環境を既定にする。未構成の挙動は個別テストで。
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "picker-api-key");
  vi.resetModules();
  window.localStorage.clear();
  tokenCallback = null;
  errorCallback = null;
  credentialCallback = null;
  requestAccessToken.mockClear();
  initTokenClient.mockClear();
  (window as unknown as { google: unknown }).google = {
    accounts: {
      id: {
        initialize: vi.fn(
          (config: { callback: (res: { credential?: string; select_by?: string }) => void }) => {
            credentialCallback = config.callback;
          },
        ),
        renderButton: vi.fn(),
        prompt: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
      oauth2: { initTokenClient },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { google?: unknown }).google;
});

describe("requestDriveAccess（drive.file 同意）", () => {
  it("許可（drive.file を含むトークン）でトークンを返し driveGranted=true", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    let resolved: string | null = null;
    await act(async () => {
      const p = result.current.requestDriveAccess();
      tokenCallback?.({ access_token: "drive-tok", expires_in: 3600, scope: DRIVE_SCOPE });
      resolved = await p;
    });

    expect(requestAccessToken).toHaveBeenCalledTimes(1);
    expect(resolved).toBe("drive-tok");
    expect(result.current.driveGranted).toBe(true);
  });

  it("拒否（error_callback）で null を返し driveGranted=false（再同意導線の判定に使う）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    let resolved: string | null = "sentinel";
    await act(async () => {
      const p = result.current.requestDriveAccess();
      errorCallback?.({ type: "popup_closed" });
      resolved = await p;
    });

    expect(resolved).toBeNull();
    expect(result.current.driveGranted).toBe(false);
  });

  it("同意画面で drive.file のチェックを外されたトークンは受け取らない（fail-closed）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    let resolved: string | null = "sentinel";
    await act(async () => {
      const p = result.current.requestDriveAccess();
      tokenCallback?.({ access_token: "tok", expires_in: 3600, scope: "openid email" });
      resolved = await p;
    });

    expect(resolved).toBeNull();
    expect(result.current.driveGranted).toBe(false);
  });

  it("有効期限内のトークンは使い回し、同意ポップアップを再度開かない", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    await act(async () => {
      const p = result.current.requestDriveAccess();
      tokenCallback?.({ access_token: "drive-tok", expires_in: 3600, scope: DRIVE_SCOPE });
      await p;
    });
    let second: string | null = null;
    await act(async () => {
      second = await result.current.requestDriveAccess();
    });

    expect(second).toBe("drive-tok");
    expect(requestAccessToken).toHaveBeenCalledTimes(1); // 2 回目はポップアップ無し。
  });

  it("ログアウトでトークンと同意状態を破棄する（前ユーザーの Drive を読めない）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    await act(async () => {
      const p = result.current.requestDriveAccess();
      tokenCallback?.({ access_token: "drive-tok", expires_in: 3600, scope: DRIVE_SCOPE });
      await p;
    });
    act(() => result.current.signOut());

    expect(result.current.driveGranted).toBeNull();
    await act(async () => {
      const p = result.current.requestDriveAccess();
      // 使い回しではなく再同意（requestAccessToken が再度呼ばれる）。
      expect(requestAccessToken).toHaveBeenCalledTimes(2);
      errorCallback?.({ type: "popup_closed" });
      await p;
    });
  });
});

describe("ログイン時の自動同意（要件: ログインのタイミングで権限をいただく）", () => {
  it("明示ログイン（select_by=btn）の直後に Drive 同意を求める", async () => {
    const { useGoogleAuth } = await import("./auth");
    renderHook(() => useGoogleAuth());

    await act(async () => {
      credentialCallback?.({ credential: makeJwt(), select_by: "btn" });
    });

    await waitFor(() => expect(requestAccessToken).toHaveBeenCalledTimes(1));
  });

  it("静かな復元（select_by=auto）ではポップアップを出さない（操作時に再同意へ委ねる）", async () => {
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    await act(async () => {
      credentialCallback?.({ credential: makeJwt(), select_by: "auto" });
    });

    expect(result.current.loggedIn).toBe(true);
    expect(requestAccessToken).not.toHaveBeenCalled();
  });

  it("Drive 未構成（Picker API キー無し）の環境では同意を求めない（Codex P2）", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "");
    vi.resetModules();
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    await act(async () => {
      credentialCallback?.({ credential: makeJwt(), select_by: "btn" });
    });

    // ログインは成立するが、使えない Drive の権限ポップアップは出さない。
    expect(result.current.loggedIn).toBe(true);
    expect(requestAccessToken).not.toHaveBeenCalled();
  });
});
