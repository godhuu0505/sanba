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

  it("SANBA(agent) と あなた(user) を author 区別で吹き出し表示する", () => {
    render(
      <ChatHistory
        transcript={[
          line({ utterance_id: "u1", role: "assistant", text: "何を規矩としましょう" }),
          line({ utterance_id: "u2", role: "user", text: "新しき順がよい" }),
        ]}
      />,
    );
    expect(screen.getByLabelText("SANBA").textContent).toContain("何を規矩としましょう");
    expect(screen.getByLabelText("あなた").textContent).toContain("新しき順がよい");
  });

  it("partial（final=false）は「認識中」を示す", () => {
    render(
      <ChatHistory
        transcript={[line({ utterance_id: "u3", role: "user", text: "価格の安き", final: false })]}
      />,
    );
    expect(screen.getByText(/認識中/)).toBeTruthy();
    expect(screen.getByLabelText("あなた").textContent).toContain("価格の安き");
  });
});
