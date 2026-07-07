// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./auth";

function Consumer({ id }: { id: string }) {
  const { loggedIn, devSignIn } = useAuth();
  return (
    <div>
      <span data-testid={`state-${id}`}>{loggedIn ? "in" : "out"}</span>
      <button type="button" onClick={devSignIn}>
        signin-{id}
      </button>
    </div>
  );
}

describe("AuthProvider / useAuth（共有インスタンス）", () => {
  afterEach(() => cleanup());

  it("Provider 外で useAuth を呼ぶと throw する", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer id="x" />)).toThrow(/AuthProvider/);
    spy.mockRestore();
  });

  it("配下の複数 consumer が同一 auth 状態を共有する（dev: 片方の devSignIn が両方へ反映）", () => {
    render(
      <AuthProvider>
        <Consumer id="a" />
        <Consumer id="b" />
      </AuthProvider>,
    );
    expect(screen.getByTestId("state-a").textContent).toBe("out");
    expect(screen.getByTestId("state-b").textContent).toBe("out");

    act(() => {
      fireEvent.click(screen.getByText("signin-a"));
    });

    expect(screen.getByTestId("state-a").textContent).toBe("in");
    expect(screen.getByTestId("state-b").textContent).toBe("in");
  });
});
