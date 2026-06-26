// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionState } from "@/lib/realtime/store";
import type { Detection, Requirement } from "@/lib/realtime/types";

import { ConversationSessionView } from "./ConversationSessionView";

// 会話シェルの結線（Phase 6）。共有 realtime state を 3 タブ＋問いピン＋ボトムバーへ配り、
// 検知ドリブンの選択肢回答・終了→判定→結果までを通す。
// 仕様: docs/design/conversation-experience.md §2,§4,§7。

const req = (over: Partial<Requirement>): Requirement => ({
  id: "r1",
  statement: "キーワード検索を新設する。",
  category: "functional",
  priority: "must",
  confidence: 0.86,
  source_speaker: "顧客",
  citations: [],
  status: "confirmed",
  ...over,
});

const det = (over: Partial<Detection>): Detection => ({
  id: "d1",
  kind: "contradiction",
  summary: "関連度順か新着順か。",
  refs: ["u1"],
  detector: "contradiction_detector",
  resolved: false,
  ...over,
});

const baseState = (over: Partial<SessionState> = {}): SessionState => ({
  phase: "listening",
  agentsActive: 0,
  requirements: [req({})],
  detections: [
    det({
      id: "d1",
      summary: "関連度順か新着順か。",
      options: [
        { label: "関連度順にする", value: "relevance" },
        { label: "新着順にする", value: "recency" },
      ],
    }),
    det({ id: "d2", kind: "gap", summary: "『該当なし』の空状態が未定義。", category: "scope" }),
  ],
  transcript: [
    { utterance_id: "u1", speaker: "顧客", role: "customer", text: "検索は関連度順で。", final: true },
  ],
  analysis: [{ asset_id: "a1", pct: 40, stage: "OCR", extracted: [], conflicts: [] }],
  completed: null,
  seq: 9,
  ...over,
});

function renderView(props: Partial<React.ComponentProps<typeof ConversationSessionView>> = {}) {
  const sendSelection = vi.fn();
  const onToggleMic = vi.fn();
  const onToggleMute = vi.fn();
  const onSendText = vi.fn();
  const onAddMaterial = vi.fn();
  render(
    <ConversationSessionView
      state={baseState()}
      sendSelection={sendSelection}
      micOn
      muted={false}
      onToggleMic={onToggleMic}
      onToggleMute={onToggleMute}
      onSendText={onSendText}
      onAddMaterial={onAddMaterial}
      onExport={vi.fn(async () => ({ exported: true, issue_url: "u", count: 1 }))}
      {...props}
    />,
  );
  return { sendSelection, onToggleMic, onToggleMute, onSendText, onAddMaterial };
}

describe("ConversationSessionView（会話シェル結線）", () => {
  afterEach(() => cleanup());

  it("ミニ状況に実データ件数（要件1・未確定2・資料1 解析中）を出す", () => {
    renderView();
    expect(screen.getByRole("button", { name: /要件 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /未確定 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /資料 1/ })).toBeTruthy();
    expect(screen.getByText(/解析中/)).toBeTruthy();
  });

  it("既定の会話履歴タブに transcript の吹き出しを出す", () => {
    renderView();
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });

  it("参考資料タブに selectMaterials 由来の素材行を出す", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByLabelText("資料 a1")).toBeTruthy();
  });

  it("要件絵巻タブに要件と未解消の深掘り対象を出す", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "要件絵巻" }));
    expect(screen.getByText("キーワード検索を新設する。")).toBeTruthy();
    expect(screen.getByText("『該当なし』の空状態が未定義。")).toBeTruthy();
  });

  it("選択肢つき未解消検知を問いピンに出し、回答で sendSelection(detectionId, value) を送る", () => {
    const { sendSelection } = renderView();
    expect(screen.getByText("関連度順か新着順か。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "関連度順にする" }));
    expect(sendSelection).toHaveBeenCalledWith("d1", "relevance");
  });

  it("回答インデックス→options[index].value の写像が正しい（2番目=recency）", () => {
    const { sendSelection } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "新着順にする" }));
    expect(sendSelection).toHaveBeenCalledWith("d1", "recency");
  });

  it("ボトムバーのマイク/消音トグルとテキスト送信が配線される", () => {
    const { onToggleMic, onToggleMute, onSendText } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "会話（マイク）" }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "消音" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("テキストで入力"), { target: { value: "新着順で" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(onSendText).toHaveBeenCalledWith("新着順で");
  });

  it("⏹→終了確認→終了するで判定へ進み、未解消2件は確定不可で問答へ戻れる", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    expect(screen.getByRole("dialog", { name: "終了確認" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    expect(screen.getByText(/未解消 2 件 ・ 確定不可/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "要件を確定する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "問答に戻って解く" }));
    // シェルに戻り、会話履歴が再び見える。
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });

  it("未解消0件なら判定で確定でき、結果へ進む", () => {
    renderView({ state: baseState({ detections: [] }) });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(screen.getByText(/要件、産まれました/)).toBeTruthy();
    expect(screen.getByText(/確定要件 1 件/)).toBeTruthy();
  });

  it("深掘りの『会話で確認』で会話履歴タブへ戻す", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "要件絵巻" }));
    expect(screen.queryByText("検索は関連度順で。")).toBeNull();
    const jumps = screen.getAllByRole("button", { name: "会話で確認 ›" });
    fireEvent.click(jumps[0]);
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });
});
