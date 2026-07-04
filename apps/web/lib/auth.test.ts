// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOGOUT_CHANNEL, useGoogleAuth } from "./auth";

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
