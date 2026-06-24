// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Button,
  ChatBubble,
  Chip,
  RequirementCard,
  SessionRow,
  Waveform,
} from "./index";

afterEach(cleanup);

describe("SANBA design system", () => {
  it("Button は variant に応じてクラスを切り替える", () => {
    const { rerender } = render(<Button variant="gold">金</Button>);
    const btn = screen.getByRole("button", { name: "金" });
    expect(btn.className).toContain("sanba-gold-gradient");

    rerender(<Button variant="outline">枠</Button>);
    expect(screen.getByRole("button", { name: "枠" }).className).toContain("border");
  });

  it("Button asChild はラッパ要素に化ける（アンカー化）", () => {
    render(
      <Button asChild>
        <a href="/start">始める</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "始める" });
    expect(link).toHaveProperty("tagName", "A");
    expect(link.className).toContain("sanba-gold-gradient");
  });

  it("ChatBubble は話者で左右と面色を出し分ける", () => {
    const { container, rerender } = render(<ChatBubble author="agent">問い</ChatBubble>);
    // エージェントは左寄せ（justify-start）。
    expect(container.firstElementChild?.className).toContain("justify-start");

    rerender(<ChatBubble author="user">答え</ChatBubble>);
    // 参加者は右寄せ（flex-row-reverse）。
    expect(container.firstElementChild?.className).toContain("flex-row-reverse");
  });

  it("Chip は selected で塗り強調になる", () => {
    render(
      <Chip tone="gold" selected>
        企画
      </Chip>,
    );
    const chip = screen.getByText("企画");
    expect(chip.getAttribute("data-selected")).not.toBeNull();
    expect(chip.className).toContain("sanba-gold-gradient");
  });

  it("RequirementCard は状態ラベルを表示し、handler 有りで操作三択を出す", () => {
    render(
      <RequirementCard status="approved" showActions>
        無限スクロールで表示する
      </RequirementCard>,
    );
    expect(screen.getByText("承認済み")).toBeTruthy();
    expect(screen.getByRole("button", { name: "認める" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "退ける" })).toBeTruthy();
  });

  it("SessionRow は既定の操作ピル「検める ›」を出す", () => {
    render(<SessionRow title="検索機能" meta="pm@example.com" />);
    expect(screen.getByText("検索機能")).toBeTruthy();
    expect(screen.getByText("検める ›")).toBeTruthy();
  });

  it("Waveform は状態に応じた aria-label を持つ", () => {
    const { rerender } = render(<Waveform state="active" />);
    expect(screen.getByRole("img", { name: "集音中" })).toBeTruthy();
    rerender(<Waveform state="muted" />);
    expect(screen.getByRole("img", { name: "ミュート中" })).toBeTruthy();
  });
});
