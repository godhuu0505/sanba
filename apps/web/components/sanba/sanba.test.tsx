// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppHeader,
  Button,
  ChatBubble,
  Chip,
  InsightCard,
  ListRow,
  Marquee,
  Parade,
  RecPill,
  RequirementCard,
  SessionRow,
  Waveform,
} from "./index";

afterEach(cleanup);

describe("SANBA design system", () => {
  it("Button は variant に応じてクラスを切り替える", () => {
    const { rerender } = render(<Button variant="gold">主</Button>);
    const btn = screen.getByRole("button", { name: "主" });
    // 主 CTA は朱ステッカー（2px 墨枠＋墨オフセット影）。白文字を載せる面は AA 安全な朱
    // #C43A20（--sanba-rec-text / ADR-0033）。
    expect(btn.className).toContain("border-sanba-frame");
    expect(btn.className).toContain("bg-sanba-rec-text");

    rerender(<Button variant="outline">枠</Button>);
    const outline = screen.getByRole("button", { name: "枠" }).className;
    // 白ステッカーも 2px 墨枠。ただし朱面は載せない。
    expect(outline).toContain("border-sanba-frame");
    expect(outline).not.toContain("bg-sanba-rec-text");
  });

  it("Button asChild はラッパ要素に化ける（アンカー化）", () => {
    render(
      <Button asChild>
        <a href="/start">始める</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "始める" });
    expect(link).toHaveProperty("tagName", "A");
    expect(link.className).toContain("border-sanba-frame");
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

  it("SessionRow action=null は操作ピルを出さない（閲覧専用の行 / Codex P2）", () => {
    render(<SessionRow title="検索機能" meta="pm@example.com" action={null} />);
    expect(screen.getByText("検索機能")).toBeTruthy();
    expect(screen.queryByText("検める ›")).toBeNull();
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

  it("RecPill は朱枠の丸薬に glowPulse のドットと REC 文言を出す（ADR-0033 §7）", () => {
    const { container } = render(<RecPill>12:46</RecPill>);
    // 先頭ラベル＋経過時間が同じピル内に並ぶ。
    expect(screen.getByText(/REC 12:46/)).toBeTruthy();
    // 発光ドットは reduced-motion で静止する .sanba-rec-dot を持つ（装飾なので aria-hidden）。
    const dot = container.querySelector(".sanba-rec-dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).not.toBeNull();
  });

  it("InsightCard は既定見出し「ひらめき」＋山吹淡・破線の札（ADR-0033 §7）", () => {
    const { container } = render(<InsightCard>結果の並びは関連度順が要でした。</InsightCard>);
    expect(screen.getByText("ひらめき")).toBeTruthy();
    expect(screen.getByText("結果の並びは関連度順が要でした。")).toBeTruthy();
    // 山吹淡の面＋破線（電球アイコンは装飾）。
    expect(container.firstElementChild?.className).toContain("bg-sanba-gold-pale");
    expect(container.firstElementChild?.className).toContain("border-dashed");
  });

  it("Marquee は継ぎ目消しで items を 2 連結し、帯全体は装飾（aria-hidden）（ADR-0033 §5）", () => {
    const { container } = render(<Marquee items={["問いは答えを産む", "選ぶのはあなた"]} />);
    // 無限ループの継ぎ目を消すため各メッセージは 2 度描かれる。
    expect(screen.getAllByText("問いは答えを産む")).toHaveLength(2);
    // 帯は読み上げ対象にしない純装飾。
    expect(container.firstElementChild?.getAttribute("aria-hidden")).not.toBeNull();
    // 流れるトラック（reduced-motion で globals 側が静止させる）。
    expect(container.querySelector(".sanba-marquee-track")).not.toBeNull();
  });

  it("Parade は count 体の棒人間を横断させる装飾帯（aria-hidden）（ADR-0033 §5）", () => {
    const { container } = render(<Parade count={3} />);
    // 装飾チェーン（状態表示ではない）なので読み上げしない。
    expect(container.firstElementChild?.getAttribute("aria-hidden")).not.toBeNull();
    // walking の棒人間が count 体。横断アニメの担い手 .sanba-parade-walker も同数。
    expect(container.querySelectorAll("svg")).toHaveLength(3);
    expect(container.querySelectorAll(".sanba-parade-walker")).toHaveLength(3);
  });
});

// SANBA ブランドは全画面で常時表示する（2026-07 要望「どの画面でも SANBA ヘッダー」）。
describe("AppHeader（SANBA ブランド常時表示）", () => {
  it("タイトル画面でもロゴ（SANBA）を併記する", () => {
    render(<AppHeader title="管理の間" />);
    expect(screen.getByText("SANBA")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "管理の間" })).toBeTruthy();
  });

  it("タイトル無しでもロゴを出す。deprecated な brand 指定は無指定と同義（DOM へ流出しない）", () => {
    const { rerender } = render(<AppHeader />);
    expect(screen.getByText("SANBA")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();

    rerender(<AppHeader brand />);
    expect(screen.getByText("SANBA")).toBeTruthy();
    // brand 属性を DOM へ漏らさない（React unknown attribute 警告の防止）。
    expect(screen.getByRole("banner").hasAttribute("brand")).toBe(false);
  });
});
