// @vitest-environment jsdom
// 別タブでのログアウト伝播（ADR-0030: 別タブでログアウトしたら、元タブも次のアクションで
// ログインしていないことがわかり /login へ）。real モードで BroadcastChannel の受信を
// 「他タブからのログアウトの合図」として扱い、自タブの credential を落とす（loggedIn=false →
// authGate が /login?next= へ送る）。トークンを永続化しない方針（ADR-0014 §7）は不変で、
// 合図にトークン/PII は載せない。CLIENT_ID はモジュール評価時に env を読むため、
// stubEnv → resetModules → 動的 import で real モードに入る。
//
// jsdom ではタブ間配送を再現できないため、同名チャネルの他インスタンスへ postMessage を
// 配送する Fake で置き換える（実仕様どおり *送信元インスタンス自身には届けない*）。
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    for (const ch of FakeBroadcastChannel.instances) {
      if (ch === this || ch.closed || ch.name !== this.name) continue;
      ch.onmessage?.({ data } as MessageEvent);
    }
  }
  close(): void {
    this.closed = true;
  }
}

let capturedCallback: ((res: { credential?: string }) => void) | null = null;

const initialize = vi.fn((config: { callback: (res: { credential?: string }) => void }) => {
  capturedCallback = config.callback;
});
const renderButton = vi.fn();
const prompt = vi.fn();
const disableAutoSelect = vi.fn();

// 表示用 decodeProfile が base64url を読めるよう、最小の JWT 風文字列を組む。
function makeJwt(claims: Record<string, unknown> = { email: "a@example.com", name: "A" }): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  FakeBroadcastChannel.instances = [];
  capturedCallback = null;
  initialize.mockClear();
  disableAutoSelect.mockClear();
  // window.google を先に与え、setup() の同期パスで initialize/prompt を呼ばせる。
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as { google?: unknown }).google;
});

/** ログイン済みの real モード hook と、他タブ相当のチャネルを用意する共通ハーネス。 */
async function renderLoggedIn() {
  const { useGoogleAuth, LOGOUT_CHANNEL } = await import("./auth");
  const view = renderHook(() => useGoogleAuth());
  act(() => capturedCallback?.({ credential: makeJwt() }));
  expect(view.result.current.loggedIn).toBe(true);
  const otherTab = new FakeBroadcastChannel(LOGOUT_CHANNEL);
  const received = vi.fn();
  otherTab.onmessage = received;
  return { view, otherTab, received };
}

describe("useGoogleAuth 別タブログアウト伝播（ADR-0030 / real モード）", () => {
  it("signOut（既定）は他タブへ logout を配送し、自タブも即ログアウトする", async () => {
    const { view, received } = await renderLoggedIn();

    act(() => view.result.current.signOut());
    expect(view.result.current.loggedIn).toBe(false);
    // 他タブ（同名チャネル）が合図を受け取っている。
    expect(received).toHaveBeenCalledTimes(1);
    // 以後は静かな再取得（auto_select）で復活しないよう無効化する。
    expect(disableAutoSelect).toHaveBeenCalled();
  });

  it("signOut({ broadcast: false })（401 回復・キャンセル導線）は他タブへ配送しない", async () => {
    const { view, received } = await renderLoggedIn();

    act(() => view.result.current.signOut({ broadcast: false }));
    // 自タブのログアウトは成立しつつ、他タブは巻き添えにしない。
    expect(view.result.current.loggedIn).toBe(false);
    expect(received).not.toHaveBeenCalled();
  });

  it("他タブからの合図（onmessage）で loggedIn=false に落ち、調査用の痕跡を残す", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { view, otherTab } = await renderLoggedIn();

    // 別タブでログアウト → このタブの購読チャネルへ配送される。
    act(() => otherTab.postMessage("logout"));
    expect(view.result.current.loggedIn).toBe(false);
    expect(disableAutoSelect).toHaveBeenCalled();
    // 強制ログアウトの breadcrumb（CLAUDE.md 原則3）。
    expect(info).toHaveBeenCalledWith("[auth] cross-tab logout received");
  });

  it("アンマウントで購読チャネルを close する（リーク防止）", async () => {
    const { view } = await renderLoggedIn();
    // instances[0] = hook が購読用に作ったチャネル（otherTab より先に生成される）。
    const hookChannel = FakeBroadcastChannel.instances[0];
    expect(hookChannel.closed).toBe(false);

    view.unmount();
    expect(hookChannel.closed).toBe(true);
  });

  it("BroadcastChannel の無い環境でもタブ間伝播だけを諦め、自タブの signOut は成立する", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { useGoogleAuth } = await import("./auth");
    const { result } = renderHook(() => useGoogleAuth());

    act(() => capturedCallback?.({ credential: makeJwt() }));
    expect(result.current.loggedIn).toBe(true);

    act(() => result.current.signOut());
    expect(result.current.loggedIn).toBe(false);
  });
});
