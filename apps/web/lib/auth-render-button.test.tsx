// @vitest-environment jsdom
// real モード（NEXT_PUBLIC_GOOGLE_CLIENT_ID 設定済み）で GIS の renderButton が
// ADR-0052 の承認バリアント引数（theme:"outline" / text:"signin_with" /
// locale:"ja"、size/shape は維持）で呼ばれることを担保する。白い紙面（ADR-0025）に
// 馴染む白系ボタンへ戻し、金彩フレーム＋暗色ボタン（旧 ADR-0019）は廃止した。CLIENT_ID は
// モジュール評価時に env を読むため、stubEnv → resetModules → 動的 import で real モードに入る。
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderButton = vi.fn();
const initialize = vi.fn();
const prompt = vi.fn();
const disableAutoSelect = vi.fn();

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com");
  vi.resetModules();
  renderButton.mockClear();
  initialize.mockClear();
  prompt.mockClear();
  // GIS スクリプトを読み込まずに setup() の同期パスへ入れるよう、window.google を先に与える。
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (window as unknown as { google?: unknown }).google;
});

describe("useGoogleAuth renderButton 引数（real モード / ADR-0019）", () => {
  it("theme:outline / text:signin_with / locale:ja で純正ボタンを描画する（size/shape 維持）", async () => {
    const { useGoogleAuth } = await import("./auth");

    function Harness() {
      const { buttonRef } = useGoogleAuth();
      return <div ref={buttonRef} />;
    }

    render(<Harness />);

    expect(renderButton).toHaveBeenCalledTimes(1);
    const [, options] = renderButton.mock.calls[0];
    expect(options).toMatchObject({
      theme: "outline",
      text: "signin_with",
      locale: "ja",
      size: "large",
      shape: "pill",
    });
    // 白い紙面（ADR-0025）に馴染む白系ボタンへ戻した。暗色バリアント（旧 ADR-0019）は使わない。
    expect(options).not.toMatchObject({ theme: "filled_black" });
    expect(options).not.toMatchObject({ text: "continue_with" });
  });

  it("GIS script URL は hl=ja で言語固定する（script ?hl= と JS locale の併用 / ADR-0019）", async () => {
    // window.google 未定義にして script 読み込みパスへ入れる。
    delete (window as unknown as { google?: unknown }).google;
    const { useGoogleAuth } = await import("./auth");

    function Harness() {
      const { buttonRef } = useGoogleAuth();
      return <div ref={buttonRef} />;
    }

    render(<Harness />);

    const script = document.querySelector<HTMLScriptElement>('script[src*="accounts.google.com/gsi/client"]');
    expect(script).not.toBeNull();
    expect(script?.src).toContain("hl=ja");
  });
});
