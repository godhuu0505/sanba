// @vitest-environment jsdom
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
    expect(options).not.toMatchObject({ theme: "filled_black" });
    expect(options).not.toMatchObject({ text: "continue_with" });
  });

  it("GIS script URL は hl=ja で言語固定する（script ?hl= と JS locale の併用 / ADR-0019）", async () => {
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
