// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InterviewModeProvider } from "@/lib/interviewMode";

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

  it("前提の読み込み（context.progress）をセットアップ吹き出しで表示する", () => {
    render(
      <ChatHistory
        transcript={[]}
        contextProgress={[
          { source: "prep", stage: "done", label: "ゴールとゴール詳細", detail: "確認" },
          {
            source: "repo",
            stage: "running",
            label: "octo/app@main",
            detail: "ソースコードを読み込み中",
          },
        ]}
      />,
    );
    expect(screen.getByText("ゴールとゴール詳細")).toBeTruthy();
    expect(screen.getByText("octo/app@main")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /octo\/app@main/ })).toBeTruthy();
  });

  it("解析中の素材はプログレスバー付きの吹き出しで進捗を出す", () => {
    render(
      <ChatHistory
        transcript={[]}
        materials={[
          { id: "a1", name: "capture-01.png", pct: 65, status: "analyzing" },
          { id: "a2", name: "capture-02.png", pct: 100, status: "done", extracted: 3 },
        ]}
      />,
    );
    expect(screen.getByText("capture-01.png")).toBeTruthy();
    expect(screen.getByText(/解析中… 65%/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /capture-01\.png/ })).toBeTruthy();
    expect(screen.getByText(/抽出 3 件/)).toBeTruthy();
  });

  it("アップロード中・キャンセル済みの素材は会話履歴に出さない", () => {
    render(
      <ChatHistory
        transcript={[]}
        materials={[
          { id: "a1", name: "up.png", pct: 0, status: "uploading" },
          { id: "a2", name: "cx.png", pct: 0, status: "cancelled" },
        ]}
      />,
    );
    expect(screen.getByText(/話しかけてください/)).toBeTruthy();
    expect(screen.queryByText("up.png")).toBeNull();
    expect(screen.queryByText("cx.png")).toBeNull();
  });

  it("end_user では資料/リポジトリ解析が対象外であることを明示する（#434 task3）", () => {
    render(
      <InterviewModeProvider value="end_user">
        <ChatHistory transcript={[]} />
      </InterviewModeProvider>,
    );
    expect(screen.getByText("資料/リポジトリ解析：対象外")).toBeTruthy();
  });

  it("developer では対象外表示を出さない（回帰なし）", () => {
    render(
      <InterviewModeProvider value="developer">
        <ChatHistory transcript={[line({ utterance_id: "u1", text: "はい" })]} />
      </InterviewModeProvider>,
    );
    expect(screen.queryByText("資料/リポジトリ解析：対象外")).toBeNull();
  });
});
