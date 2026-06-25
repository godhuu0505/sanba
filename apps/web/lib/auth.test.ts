// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useGoogleAuth } from "./auth";

// テスト環境では NEXT_PUBLIC_GOOGLE_CLIENT_ID 未設定 → dev モード。
describe("useGoogleAuth", () => {
  it("dev モード（CLIENT_ID 未設定）は ready=true で即解決し、初期は未ログイン", () => {
    const { result } = renderHook(() => useGoogleAuth());
    expect(result.current.devMode).toBe(true);
    expect(result.current.ready).toBe(true);
    expect(result.current.loggedIn).toBe(false);
  });
});
