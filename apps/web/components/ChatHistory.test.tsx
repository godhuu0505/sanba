// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatHistory } from "./ChatHistory";

const line = (over: Partial<Record<string, unknown>>) => ({
  utterance_id: "u",
  speaker: "x",
  role: "agent",
  text: "t",
  final: true,
  ...over,
});

describe("ChatHistory（会話履歴タブ）", () => {
  afterEach(() => cleanup());

  it("空のときは待機メッセージを出す", () => {
    render(<ChatHistory transcript={[]} />);
    expect(screen.getByText(/話しかけてください/)).toBeTruthy();
  });

  it("SANBA(agent) と あなた(参加者) を author 区別で吹き出し表示する", () => {
    render(
      <ChatHistory
        transcript={[
          line({ utterance_id: "u1", role: "assistant", text: "何を規矩としましょう" }),
          line({ utterance_id: "u2", role: "participant", text: "新しき順がよい" }),
          line({ utterance_id: "u4", role: "customer", text: "価格も大事" }),
        ]}
      />,
    );
    expect(screen.getByLabelText("SANBA").textContent).toContain("何を規矩としましょう");
    const me = screen.getAllByLabelText("あなた");
    expect(me.map((n) => n.textContent).join("")).toContain("新しき順がよい");
    expect(me.map((n) => n.textContent).join("")).toContain("価格も大事");
  });

  it("partial（final=false）は「文字起こし中」を示す", () => {
    render(
      <ChatHistory
        transcript={[line({ utterance_id: "u3", role: "participant", text: "価格の安き", final: false })]}
      />,
    );
    expect(screen.getByText(/文字起こし中/)).toBeTruthy();
    expect(screen.getByLabelText("あなた").textContent).toContain("価格の安き");
  });
});
