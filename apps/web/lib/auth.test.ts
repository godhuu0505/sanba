// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeProfile, LOGOUT_CHANNEL, useGoogleAuth } from "./auth";

// 検証しない表示用デコード（decodeProfile）用に、任意の payload で JWT 風トークンを組む。
// header/署名はダミー（本関数は payload だけを見る）。payload は base64url かつ UTF-8。
function makeIdToken(payload: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

describe("decodeProfile", () => {
  it("UTF-8 の日本語名を文字化けさせずに復号する（#227 プロフィール文字化け回帰）", () => {
    const token = makeIdToken({
      email: "godai.tanaka@leverages.jp",
      name: "田中 五大",
      picture: "https://example.com/a.png",
    });
    const profile = decodeProfile(token);
    expect(profile).toEqual({
      email: "godai.tanaka@leverages.jp",
      name: "田中 五大",
      picture: "https://example.com/a.png",
    });
  });

  it("name 欠落時は email にフォールバックし、picture 欠落は undefined", () => {
    const token = makeIdToken({ email: "guest@example.com" });
    expect(decodeProfile(token)).toEqual({
      email: "guest@example.com",
      name: "guest@example.com",
      picture: undefined,
    });
  });

  it("壊れたトークンは null を返す（表示用途なので例外を投げない）", () => {
    expect(decodeProfile("not-a-jwt")).toBeNull();
  });
});

// dev モードがログアウト伝播チャネル（ADR-0030）を購読しないことを確かめる最小 Fake。
// 実仕様どおり、送信元インスタンス以外の同名チャネルへ postMessage を配送する。
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

// テスト環境では NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定 → dev モード。
describe("useGoogleAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances = [];
  });

  it("dev モード（CLIENT_ID 未設定）は ready=true で即解決し、初期は未ログイン", () => {
    const { result } = renderHook(() => useGoogleAuth());
    expect(result.current.devMode).toBe(true);
    expect(result.current.ready).toBe(true);
    expect(result.current.loggedIn).toBe(false);
  });

  it("dev モードはログアウト伝播チャネルを購読せず、送受信とも他タブと連動しない", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const { result } = renderHook(() => useGoogleAuth());
    act(() => result.current.devSignIn());
    expect(result.current.loggedIn).toBe(true);

    // 購読しない: hook はチャネルを作らない（AUTH_DEV_BYPASS に委ねる / ADR-0030）。
    expect(FakeBroadcastChannel.instances.length).toBe(0);

    // 受信しない: 他タブ相当の合図を流しても devLoggedIn は落ちない。
    const otherTab = new FakeBroadcastChannel(LOGOUT_CHANNEL);
    const received = vi.fn();
    otherTab.onmessage = received;
    act(() => otherTab.postMessage("logout"));
    expect(result.current.loggedIn).toBe(true);

    // 送信しない: 自タブの signOut は成立するが、他タブへは配送されない。
    act(() => result.current.signOut());
    expect(result.current.loggedIn).toBe(false);
    expect(received).not.toHaveBeenCalled();
  });
});
