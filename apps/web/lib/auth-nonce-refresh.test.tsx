// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let capturedCallback: ((res: { credential?: string }) => void) | null = null;
let capturedNonces: Array<string | undefined> = [];

const initialize = vi.fn(
  (config: { callback: (res: { credential?: string }) => void; nonce?: string }) => {
    capturedCallback = config.callback;
    capturedNonces.push(config.nonce);
  },
);
const renderButton = vi.fn();
const prompt = vi.fn();
const disableAutoSelect = vi.fn();

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

function stubFetch(nonceBody: { nonce: string; token: string; expires_at: number } | null) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes("/api/auth/nonce")) {
      if (nonceBody === null) return Promise.reject(new Error("nonce unavailable"));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(nonceBody) });
    }
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  vi.useFakeTimers();
  window.localStorage.clear();
  capturedCallback = null;
  capturedNonces = [];
  initialize.mockClear();
  prompt.mockClear();
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as unknown as { google?: unknown }).google;
});

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3900;

describe("ログイン nonce のペアリング（ADR-0047 §2）", () => {
  it("claim がエンベロープと一致する credential の到着で X-Auth-Nonce が有効化される", async () => {
    const apiCalls = stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");
    const { fetchMySessions } = await import("./api");

    renderHook(() => useGoogleAuth());
    await flush();

    act(() => capturedCallback?.({ credential: makeJwt({ nonce: "raw-1" }) }));
    await flush();

    await fetchMySessions("tok");
    expect(apiCalls.at(-1)?.headers["X-Auth-Nonce"]).toBe("env-1");
  });

  it("claim の無い credential ではヘッダを送らず、1 回だけ nonce 付きで採り直す", async () => {
    const apiCalls = stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");
    const { fetchMySessions } = await import("./api");

    renderHook(() => useGoogleAuth());
    await flush();
    const promptsBefore = prompt.mock.calls.length;

    act(() => capturedCallback?.({ credential: makeJwt({ email: "a@example.com" }) }));
    await flush();

    await fetchMySessions("tok");
    expect(apiCalls.at(-1)?.headers["X-Auth-Nonce"]).toBeUndefined();
    expect(capturedNonces.at(-1)).toBe("raw-1");
    expect(prompt.mock.calls.length).toBe(promptsBefore + 1);

    act(() => capturedCallback?.({ credential: makeJwt({ nonce: "raw-1" }) }));
    await flush();
    await fetchMySessions("tok");
    expect(apiCalls.at(-1)?.headers["X-Auth-Nonce"]).toBe("env-1");
  });

  it("nonce API が落ちていてもログインは成立する（ヘッダ無し運転）", async () => {
    const apiCalls = stubFetch(null);
    const { useGoogleAuth } = await import("./auth");
    const { fetchMySessions } = await import("./api");

    const { result } = renderHook(() => useGoogleAuth());
    await flush();
    const promptsBefore = prompt.mock.calls.length;

    act(() => capturedCallback?.({ credential: makeJwt({ email: "a@example.com" }) }));
    await flush();

    expect(result.current.loggedIn).toBe(true);
    await fetchMySessions("tok");
    expect(apiCalls.at(-1)?.headers["X-Auth-Nonce"]).toBeUndefined();
    expect(prompt.mock.calls.length).toBe(promptsBefore);
  });
});

describe("exp 先読みリフレッシュ（ADR-0047 §1）", () => {
  it("失効 5 分前に静かな再取得（initialize + prompt）が走る", async () => {
    stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");

    renderHook(() => useGoogleAuth());
    await flush();

    const exp = Math.floor(Date.now() / 1000) + 3600;
    act(() => capturedCallback?.({ credential: makeJwt({ nonce: "raw-1", exp }) }));
    await flush();
    const promptsBefore = prompt.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(54 * 60 * 1000);
    });
    expect(prompt.mock.calls.length).toBe(promptsBefore);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(prompt.mock.calls.length).toBe(promptsBefore + 1);
  });

  it("ログアウトで予約は解除され、時間が経っても prompt しない（再ログイン誘発防止）", async () => {
    stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");

    const { result } = renderHook(() => useGoogleAuth());
    await flush();

    const exp = Math.floor(Date.now() / 1000) + 3600;
    act(() => capturedCallback?.({ credential: makeJwt({ nonce: "raw-1", exp }) }));
    await flush();

    act(() => result.current.signOut());
    await flush();
    const promptsAfterSignOut = prompt.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    });
    expect(prompt.mock.calls.length).toBe(promptsAfterSignOut);
  });
});

describe("decodeExpiryMs（ADR-0047 §1）", () => {
  it("exp claim をミリ秒で返し、壊れたトークンは null", async () => {
    const { decodeExpiryMs } = await import("./auth");
    expect(decodeExpiryMs(makeJwt({ exp: 1234 }))).toBe(1_234_000);
    expect(decodeExpiryMs(makeJwt({}))).toBeNull();
    expect(decodeExpiryMs("garbage")).toBeNull();
  });
});
