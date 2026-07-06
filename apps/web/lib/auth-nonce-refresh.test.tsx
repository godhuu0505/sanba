// @vitest-environment jsdom
// ADR-0046: ログイン nonce のペアリング（§2）と exp 先読みリフレッシュ（§1）。
// - X-Auth-Nonce は「エンベロープと一致する nonce claim を持つ credential が到着したとき」
//   だけ有効化される（片側だけの差し替えで自作の不一致 401 を作らない）。
// - 不成立時は 1 回だけ nonce を採り直して静かに再取得する（無限 prompt ループにしない）。
// - リフレッシュは exp-5min に予約され、ログアウトで必ず解除される。
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

/** /api/auth/nonce と一般 API を捌く fetch スタブ。API 呼び出しのヘッダを検査できるよう控える。 */
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

/** マウント直後の非同期処理（nonce 先読み等）を流す。 */
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

describe("ログイン nonce のペアリング（ADR-0046 §2）", () => {
  it("claim がエンベロープと一致する credential の到着で X-Auth-Nonce が有効化される", async () => {
    const apiCalls = stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");
    const { fetchMySessions } = await import("./api");

    renderHook(() => useGoogleAuth());
    await flush(); // nonce 先読み完了を待つ

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

    // nonce-less credential（claim を埋められなかった復元）→ 不一致ヘッダを送らない。
    act(() => capturedCallback?.({ credential: makeJwt({ email: "a@example.com" }) }));
    await flush();

    await fetchMySessions("tok");
    expect(apiCalls.at(-1)?.headers["X-Auth-Nonce"]).toBeUndefined();
    // 採り直し: nonce 付きで initialize し直し、静かな prompt を 1 回だけ追加。
    expect(capturedNonces.at(-1)).toBe("raw-1");
    expect(prompt.mock.calls.length).toBe(promptsBefore + 1);

    // 採り直しで claim 付き credential が届けばペアリング成立に自己回復する。
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
    // nonce が無いのに prompt を無駄撃ちしない（FedCM クールダウンを進めない）。
    expect(prompt.mock.calls.length).toBe(promptsBefore);
  });
});

describe("exp 先読みリフレッシュ（ADR-0046 §1）", () => {
  it("失効 5 分前に静かな再取得（initialize + prompt）が走る", async () => {
    stubFetch({ nonce: "raw-1", token: "env-1", expires_at: FUTURE_EXP() });
    const { useGoogleAuth } = await import("./auth");

    renderHook(() => useGoogleAuth());
    await flush();

    const exp = Math.floor(Date.now() / 1000) + 3600;
    act(() => capturedCallback?.({ credential: makeJwt({ nonce: "raw-1", exp }) }));
    await flush();
    const promptsBefore = prompt.mock.calls.length;

    // exp-5min より手前では発火しない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(54 * 60 * 1000);
    });
    expect(prompt.mock.calls.length).toBe(promptsBefore);

    // exp-5min を跨ぐと静かな再取得が走る。
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

describe("decodeExpiryMs（ADR-0046 §1）", () => {
  it("exp claim をミリ秒で返し、壊れたトークンは null", async () => {
    const { decodeExpiryMs } = await import("./auth");
    expect(decodeExpiryMs(makeJwt({ exp: 1234 }))).toBe(1_234_000);
    expect(decodeExpiryMs(makeJwt({}))).toBeNull();
    expect(decodeExpiryMs("garbage")).toBeNull();
  });
});
