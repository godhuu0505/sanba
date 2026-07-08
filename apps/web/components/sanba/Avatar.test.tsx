// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar } from "./Avatar";

describe("Avatar", () => {
  afterEach(() => cleanup());

  it("glyph をアクセシビリティツリー外の記号として表示する（画像なし）", () => {
    const { container } = render(<Avatar tone="user" glyph="産" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("産");
  });

  it("imageUrl を渡すと画像アバターを描画する（alt を反映）", () => {
    render(<Avatar tone="user" glyph="産" imageUrl="https://example.com/p.png" alt="あなた" />);
    const img = screen.getByRole("img", { name: "あなた" });
    expect(img.getAttribute("src")).toBe("https://example.com/p.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
