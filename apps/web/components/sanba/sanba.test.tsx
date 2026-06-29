// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Button,
  ChatBubble,
  Chip,
  ListRow,
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

  // #162: 複数子（icon/title/trailing）を持つ行でも asChild がクラッシュせず host 要素に化ける。
  it("ListRow asChild は複数子のままアンカー化し内容を内包する（Slot 複数子クラッシュ回避）", () => {
    render(
      <ListRow asChild icon={<span>📷</span>} title="カメラで撮る" subtitle="写真を解析">
        <a href="/camera" />
      </ListRow>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveProperty("tagName", "A");
    expect(link.getAttribute("href")).toBe("/camera");
    // 行の内容（title/subtitle/icon）が host 要素の中に入っている。
    expect(link.textContent).toContain("カメラで撮る");
    expect(link.textContent).toContain("写真を解析");
  });

  it("SessionRow asChild はカード全体を host 要素に化けさせる（#162）", () => {
    render(
      <SessionRow asChild title="検索機能" meta="pm@example.com">
        <a href="/sessions/1" />
      </SessionRow>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveProperty("tagName", "A");
    expect(link.getAttribute("href")).toBe("/sessions/1");
    expect(link.textContent).toContain("検索機能");
    expect(link.textContent).toContain("検める ›"); // 既定の操作ピルも内包
  });

  it("ListRow 非 asChild は div で描画し children を要求しない（既定経路）", () => {
    render(<ListRow title="アップロード" subtitle="png/jpg/mp4" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("アップロード")).toBeTruthy();
  });

  it("Waveform は状態に応じた aria-label を持つ", () => {
    const { rerender } = render(<Waveform state="active" />);
    expect(screen.getByRole("img", { name: "集音中" })).toBeTruthy();
    rerender(<Waveform state="muted" />);
    expect(screen.getByRole("img", { name: "ミュート中" })).toBeTruthy();
  });
});
