// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InterviewModeProvider } from "@/lib/interviewMode";
import type { SessionState } from "@/lib/realtime/store";
import type { InquiryNode, Requirement } from "@/lib/realtime/types";

import { ConversationSessionView } from "./ConversationSessionView";

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

const node = (over: Partial<InquiryNode> & { id: string }): InquiryNode => ({
  parent_id: null,
  kind: "gap",
  text: "確認事項",
  status: "open",
  confidence: 0.6,
  depth: 0,
  origin: "conversation",
  refs: ["u1"],
  created_seq: 1,
  resolved_seq: null,
  ...over,
});

const baseState = (over: Partial<SessionState> = {}): SessionState => ({
  phase: "listening",
  agentsActive: 0,
  requirements: [req({})],
  inquiryNodes: [
    node({ id: "n1", kind: "contradiction", text: "関連度順か新着順か。", created_seq: 1 }),
    node({ id: "n2", kind: "gap", text: "『該当なし』の空状態が未定義。", created_seq: 2 }),
  ],
  transcript: [
    { utterance_id: "u1", speaker: "顧客", role: "customer", text: "検索は関連度順で。", final: true },
  ],
  analysis: [{ asset_id: "a1", pct: 40, stage: "OCR", extracted: [], conflicts: [] }],
  contextProgress: [],
  endProposal: null,
  question: null,
  completed: null,
  seq: 9,
  ...over,
});

function renderView(props: Partial<React.ComponentProps<typeof ConversationSessionView>> = {}) {
  const onToggleMic = vi.fn();
  const onToggleMute = vi.fn();
  const onSendText = vi.fn();
  const onAddMaterial = vi.fn();
  const sendAnswer = vi.fn();
  const sendInquiryDrop = vi.fn();
  render(
    <ConversationSessionView
      state={baseState()}
      sendAnswer={sendAnswer}
      sendInquiryDrop={sendInquiryDrop}
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
  return { sendAnswer, sendInquiryDrop, onToggleMic, onToggleMute, onSendText, onAddMaterial };
}

describe("ConversationSessionView（会話シェル結線）", () => {
  afterEach(() => cleanup());

  it("ミニ状況に実データ件数（要件1・未解消2・資料1 解析中）を出す", () => {
    renderView();
    expect(screen.getByRole("button", { name: /要件 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /未解消 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /資料 1/ })).toBeTruthy();
    expect(screen.getAllByText(/解析中/).length).toBeGreaterThan(0);
  });

  it("ambiguous は未解消（ゲート）に数えない", () => {
    renderView({
      state: baseState({
        inquiryNodes: [
          node({ id: "n1", kind: "gap", status: "open" }),
          node({ id: "n2", kind: "ambiguous", status: "open" }),
        ],
      }),
    });
    expect(screen.getByRole("button", { name: /未解消 1/ })).toBeTruthy();
  });

  it("既定の会話履歴タブに transcript の吹き出しを出す", () => {
    renderView();
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });

  it("参考資料タブに selectMaterials 由来の素材行を出す（解析中は詳細導線なし）", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByLabelText("参考資料 a1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /詳細を開く/ })).toBeNull();
  });

  it("done 素材の行は詳細導線（ボタン）になる", () => {
    renderView({
      state: baseState({
        analysis: [{ asset_id: "a1", pct: 100, stage: "完了", extracted: [], conflicts: [] }],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByRole("button", { name: "参考資料 a1 の詳細を開く" })).toBeTruthy();
  });

  it("素材行 → 05-1 詳細シートが開き、抽出要件と言葉×画の矛盾を出す（#202）", () => {
    renderView({
      state: baseState({
        analysis: [
          {
            asset_id: "a1",
            pct: 100,
            stage: "完了",
            extracted: ["3カラム一覧"],
            conflicts: [{ summary: "検索バーが無いが『検索したい』と発言", refs: ["u1"] }],
          },
        ],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    fireEvent.click(screen.getByRole("button", { name: "参考資料 a1 の詳細を開く" }));
    const dialog = screen.getByRole("dialog", { name: "参考資料の詳細" });
    expect(within(dialog).getByText("3カラム一覧")).toBeTruthy();
    expect(within(dialog).getByText(/検索バーが無いが/)).toBeTruthy();
  });

  it("確認事項が来ない素材でも詳細で言葉×画の矛盾を確認できる（#202 AC）", () => {
    renderView({
      state: baseState({
        inquiryNodes: [],
        analysis: [
          {
            asset_id: "a1",
            pct: 100,
            stage: "完了",
            extracted: [],
            conflicts: [{ summary: "図にだけ存在する導線（言及なし）", refs: [] }],
          },
        ],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    fireEvent.click(screen.getByRole("button", { name: "参考資料 a1 の詳細を開く" }));
    expect(screen.getByText("図にだけ存在する導線（言及なし）")).toBeTruthy();
  });

  it("再接続後の done 素材（realtime 解析行なし）は詳細で空を断定しない（Codex P2 #1）", () => {
    renderView({
      state: baseState({ analysis: [] }),
      extraMaterials: [{ id: "h1", name: "復元.png", pct: 100, status: "done", extracted: 3 }],
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    fireEvent.click(screen.getByRole("button", { name: "参考資料 復元.png の詳細を開く" }));
    const dialog = screen.getByRole("dialog", { name: "参考資料の詳細" });
    expect(within(dialog).queryByText(/見つかっていません/)).toBeNull();
    expect(within(dialog).getAllByText(/取得できていません/).length).toBeGreaterThan(0);
  });

  it("要件一覧タブに要件と確認事項ツリーのノードを出す", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "要件一覧" }));
    expect(screen.getByText("キーワード検索を新設する。")).toBeTruthy();
    expect(screen.getByText("確認事項ツリー")).toBeTruthy();
    expect(screen.getByText("『該当なし』の空状態が未定義。")).toBeTruthy();
  });

  it("確認事項ノードの『不要』で sendInquiryDrop(nodeId) を送る", () => {
    const { sendInquiryDrop } = renderView();
    fireEvent.click(screen.getByRole("tab", { name: "要件一覧" }));
    const drops = screen.getAllByRole("button", { name: /不要にする/ });
    fireEvent.click(drops[0]);
    expect(sendInquiryDrop).toHaveBeenCalledWith("n1");
  });

  it("通常質問（金枠）を問いピンに出し、回答で sendAnswer を送る（#181）", () => {
    const { sendAnswer } = renderView({
      state: baseState({
        inquiryNodes: [],
        question: {
          id: "q1",
          prompt: "並び順は何を既定にしますか",
          options: [
            { label: "関連度順", value: "relevance" },
            { label: "新着順", value: "recency" },
          ],
        },
      }),
    });
    expect(screen.getByText("並び順は何を既定にしますか")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "関連度順" }));
    expect(sendAnswer).toHaveBeenCalledWith("q1", { selectedValue: "relevance" });
    expect(screen.queryByText("並び順は何を既定にしますか")).toBeNull();
  });

  it("ボトムバーのマイク/消音トグルとテキスト送信が配線される", () => {
    const { onToggleMic, onToggleMute, onSendText } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "マイクをミュート" }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "スピーカー消音" }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("テキストで入力"), { target: { value: "新着順で" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(onSendText).toHaveBeenCalledWith("新着順で");
  });

  it("⏹→終了確認→終了するで判定へ進み、未解消2件は確定不可で会話へ戻れる", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    expect(screen.getByRole("dialog", { name: "終了確認" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    expect(screen.getByText(/未解消が 2 件あります/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "要件を確定する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会話に戻って確認する" }));
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });

  it("未解消0件なら判定で確定でき、結果へ進む", async () => {
    renderView({ state: baseState({ inquiryNodes: [] }) });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
    expect(screen.getByText(/確定した要件 1 件/)).toBeTruthy();
  });

  it("同 id の realtime 解析行が来ても実ファイル名（ローカル/復元）を保つ（#184 統合）", () => {
    renderView({
      state: baseState({ analysis: [{ asset_id: "a1", pct: 70, stage: "OCR", extracted: [], conflicts: [] }] }),
      extraMaterials: [
        { id: "a1", name: "図面.png", pct: 0, status: "uploading" },
        { id: "local:1", name: "アップ中.png", pct: 0, status: "uploading" },
      ],
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByLabelText("参考資料 図面.png")).toBeTruthy();
    expect(screen.queryByLabelText("参考資料 a1")).toBeNull();
    expect(screen.getByLabelText("参考資料 アップ中.png")).toBeTruthy();
  });

  it("中断（✕ 中断）→『中断する』で onCancelMaterial を呼ぶ（#219）", () => {
    const onCancelMaterial = vi.fn();
    renderView({
      state: baseState({ analysis: [{ asset_id: "a1", pct: 40, stage: "OCR", extracted: [], conflicts: [] }] }),
      extraMaterials: [{ id: "a1", name: "図面.png", pct: 0, status: "analyzing" }],
      onCancelMaterial,
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    fireEvent.click(screen.getByRole("button", { name: "図面.png の解析を中断" }));
    fireEvent.click(screen.getByRole("button", { name: "中断する" }));
    expect(onCancelMaterial).toHaveBeenCalledWith("a1");
  });

  it("cancelledIds の素材は参考資料・資料件数から消える（#219 復活ガード）", () => {
    renderView({
      state: baseState({ analysis: [{ asset_id: "a1", pct: 40, stage: "OCR", extracted: [], conflicts: [] }] }),
      extraMaterials: [{ id: "a1", name: "図面.png", pct: 0, status: "analyzing" }],
      cancelledIds: new Set(["a1"]),
    });
    expect(screen.getByRole("button", { name: /資料 0/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /解析中/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.queryByLabelText("参考資料 図面.png")).toBeNull();
    expect(screen.getByText(/まだありません/)).toBeTruthy();
  });

  it("確定（要件を確定する）で onFinalize を呼んでから結果へ進む（#186）", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({ state: baseState({ inquiryNodes: [] }), onFinalize });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
  });

  it("確定が失敗（409 等）したら結果へ進まず判定に留まり理由を出す（#186 / Codex P2）", async () => {
    const onFinalize = vi.fn(async () => {
      throw new Error("finalize failed: 409");
    });
    renderView({ state: baseState({ inquiryNodes: [] }), onFinalize });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/要件がまとまりました/)).toBeNull();
    expect(screen.getByRole("button", { name: "要件を確定する" })).toBeTruthy();
  });

  function gotoForceEndConfirm() {
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "未解消のまま終える" }));
  }

  it("未解消のまま終える確認ダイアログは到達不能な『確定して終える』を出さない（②）", () => {
    renderView({ onNavigateResults: vi.fn() });
    gotoForceEndConfirm();
    expect(screen.getByRole("dialog", { name: "未解消のまま終える確認" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "確定して終える" })).toBeNull();
  });

  it("未解消のまま終える→確定せず終えるでは onFinalize を呼ばない（#186 / E）", () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 0 }));
    renderView({ onFinalize, onNavigateResults: vi.fn() });
    gotoForceEndConfirm();
    fireEvent.click(screen.getByRole("button", { name: "確定せず終える" }));
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("未解消のまま終える→確定せず終えるで結果画面へ遷移し中間画面を挟まない（③）", () => {
    const onNavigateResults = vi.fn();
    const onEndSession = vi.fn();
    renderView({ onNavigateResults, onEndSession });
    gotoForceEndConfirm();
    fireEvent.click(screen.getByRole("button", { name: "確定せず終える" }));
    expect(onEndSession).toHaveBeenCalledTimes(1);
    expect(onNavigateResults).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/途中まで整理しました/)).toBeNull();
  });

  it("AI の終了提案（session.end_proposed）でカードを出し、同意で確定→結果へ進む（P1-b）", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({
      state: baseState({
        inquiryNodes: [],
        endProposal: { open_count: 0, requirement_count: 1, material_count: 0 },
      }),
      onFinalize,
    });
    expect(screen.getByRole("region", { name: "終了の提案" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /同意して終了/ }));
    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
  });

  it("終了提案中に未解消のノードが残る/現れた場合はカードを出さない（レビュー指摘）", () => {
    renderView({
      state: baseState({
        endProposal: { open_count: 0, requirement_count: 1, material_count: 0 },
      }),
    });
    expect(screen.queryByRole("region", { name: "終了の提案" })).toBeNull();
  });

  it("提案を経ていない session.completed（起票由来など）では自動確定しない（レビュー指摘）", () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({
      state: baseState({
        inquiryNodes: [],
        endProposal: null,
        completed: {
          contradictions_resolved: 0,
          gaps_found: 0,
          issues_created: 1,
          artifacts: [{ kind: "issue", url: "https://example.com/1" }],
        },
      }),
      onFinalize,
    });
    expect(onFinalize).not.toHaveBeenCalled();
    expect(screen.queryByText(/要件がまとまりました/)).toBeNull();
  });

  it("終了提案の「まだ続ける」でカードを閉じ、確定しない（P1-b）", () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({
      state: baseState({
        inquiryNodes: [],
        endProposal: { open_count: 0, requirement_count: 1, material_count: 0 },
      }),
      onFinalize,
    });
    fireEvent.click(screen.getByRole("button", { name: "まだ続ける" }));
    expect(screen.queryByRole("region", { name: "終了の提案" })).toBeNull();
    expect(onFinalize).not.toHaveBeenCalled();
  });

  it("AI が session.completed を出したら自動で確定して結果へ進む（P1-b 音声同意）", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({
      state: baseState({
        inquiryNodes: [],
        endProposal: { open_count: 0, requirement_count: 1, material_count: 0 },
        completed: {
          contradictions_resolved: 0,
          gaps_found: 0,
          issues_created: 0,
          artifacts: [],
        },
      }),
      onFinalize,
    });
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  it("終了→終了するで onLeaveConversation を呼ぶ（マイク送信停止のフック）", () => {
    const onLeaveConversation = vi.fn();
    renderView({ onLeaveConversation });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    expect(onLeaveConversation).toHaveBeenCalledTimes(1);
  });

  it("結果画面の Issue 書き出しは連打しても1回しか起票しない（重複起票防止）", async () => {
    let resolve: () => void = () => {};
    const onExport = vi.fn(
      () => new Promise<{ exported: boolean }>((r) => { resolve = () => r({ exported: true }); }),
    );
    renderView({ state: baseState({ inquiryNodes: [] }), onExport });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    const issueBtn = await screen.findByRole("button", { name: "Issue" });
    fireEvent.click(issueBtn);
    fireEvent.click(issueBtn);
    expect(onExport).toHaveBeenCalledTimes(1);
    resolve();
  });
});

describe("ConversationSessionView（セッション終了後の閲覧モード）", () => {
  afterEach(() => cleanup());

  async function endAndView(props: Partial<React.ComponentProps<typeof ConversationSessionView>> = {}) {
    const handles = renderView({ state: baseState({ inquiryNodes: [] }), ...props });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    await screen.findByText(/要件がまとまりました/);
    fireEvent.click(screen.getByRole("button", { name: /全文を確認する/ }));
    return handles;
  }

  it("終了後の確認ではボトムバー（テキスト入力・消音・マイク）と REC・終了を出さない", async () => {
    await endAndView();
    expect(screen.getByRole("tab", { name: "要件一覧" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByLabelText("テキストで入力")).toBeNull();
    expect(screen.queryByRole("button", { name: "送信" })).toBeNull();
    expect(screen.queryByRole("button", { name: "スピーカー消音" })).toBeNull();
    expect(screen.queryByRole("button", { name: "マイクをミュート" })).toBeNull();
    expect(screen.queryByText(/REC/)).toBeNull();
    expect(screen.queryByRole("button", { name: "会話を終了" })).toBeNull();
  });

  it("『結果に戻る』で結果（08）へ戻れる", async () => {
    await endAndView();
    fireEvent.click(screen.getByRole("button", { name: "結果に戻る" }));
    expect(screen.getByText(/要件がまとまりました/)).toBeTruthy();
  });

  it("終了後の参考資料タブは一覧のみで『＋素材を追加』を出さない", async () => {
    await endAndView({
      state: baseState({
        inquiryNodes: [],
        analysis: [{ asset_id: "a1", pct: 100, stage: "完了", extracted: [], conflicts: [] }],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByRole("button", { name: "参考資料 a1 の詳細を開く" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /素材を追加/ })).toBeNull();
  });

  it("未解消のまま終えた後の確認ではツリーを閲覧のみで出し、問いピンと『不要』を出さない", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "未解消のまま終える" }));
    fireEvent.click(screen.getByRole("button", { name: "確定せず終える" }));
    expect(await screen.findByText(/途中まで整理しました/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /全文を確認する/ }));
    expect(screen.getByText("『該当なし』の空状態が未定義。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /不要にする/ })).toBeNull();
  });
});

describe("ConversationSessionView（読取専用ゲスト / ADR-0032 決定4）", () => {
  afterEach(() => cleanup());

  it("参考資料タブ・資料ミニ状況・素材追加ボタンを出さない（403 を踏ませない）", () => {
    renderView({ readOnly: true });
    expect(screen.queryByRole("tab", { name: "参考資料" })).toBeNull();
    expect(screen.queryByRole("button", { name: /資料/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /素材を追加/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "会話履歴" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "要件一覧" })).toBeTruthy();
  });

  it("確認事項の『不要』は読取専用でも送れる（realtime write は許可されている）", () => {
    const { sendInquiryDrop } = renderView({ readOnly: true });
    fireEvent.click(screen.getByRole("tab", { name: "要件一覧" }));
    const drops = screen.getAllByRole("button", { name: /不要にする/ });
    fireEvent.click(drops[0]);
    expect(sendInquiryDrop).toHaveBeenCalledWith("n1");
  });

  it("確定は finalize API を呼ばずに結果へ進み、Issue 起票 UI を出さない", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    const onExport = vi.fn(async () => ({ exported: true }));
    renderView({ state: baseState({ inquiryNodes: [] }), readOnly: true, onFinalize, onExport });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(onFinalize).not.toHaveBeenCalled();
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Issue" })).toBeNull();
  });

  it("read-only は onNavigateResults 指定でも遷移せず provisional 画面へフォールバックする（③ ゲスト経路）", async () => {
    const onNavigateResults = vi.fn();
    renderView({ readOnly: true, onNavigateResults });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "未解消のまま終える" }));
    fireEvent.click(screen.getByRole("button", { name: "確定せず終える" }));
    expect(onNavigateResults).not.toHaveBeenCalled();
    expect(await screen.findByText(/途中まで整理しました/)).toBeTruthy();
  });
});

describe("ConversationSessionView（end_user モード語彙 / FR-2.4）", () => {
  afterEach(() => cleanup());

  function renderEndUser(
    props: Partial<React.ComponentProps<typeof ConversationSessionView>> = {},
  ) {
    render(
      <InterviewModeProvider value="end_user">
        <ConversationSessionView
          state={baseState()}
          sendAnswer={vi.fn()}
          sendInquiryDrop={vi.fn()}
          micOn
          muted={false}
          onToggleMic={vi.fn()}
          onToggleMute={vi.fn()}
          onSendText={vi.fn()}
          onAddMaterial={vi.fn()}
          onExport={vi.fn(async () => ({ exported: true }))}
          {...props}
        />
      </InterviewModeProvider>,
    );
  }

  it("確認事項ツリーの種別は利用者向け文言（食い違い）で、開発語彙（矛盾）を出さない", () => {
    renderEndUser();
    fireEvent.click(screen.getByRole("tab", { name: "要件一覧" }));
    expect(screen.getByText(/食い違い/)).toBeTruthy();
    expect(screen.queryByText("矛盾")).toBeNull();
  });

  it("要件タブの見出しは MoSCoW 表記を含まず、利用者向けモードでも同じ文言・優先度を出す", () => {
    renderEndUser();
    fireEvent.click(screen.getByRole("tab", { name: "要件一覧" }));
    expect(screen.queryByText(/MoSCoW/)).toBeNull();
    expect(screen.getByText("要件一覧（閲覧のみ）")).toBeTruthy();
    expect(screen.getByText("ぜひ必要")).toBeTruthy();
    expect(screen.queryByText(/Must/)).toBeNull();
  });

  it("判定画面も利用者向けモードで同じ文言（要件を確定する / Must 内訳なし）", async () => {
    renderEndUser({ state: baseState({ inquiryNodes: [] }), readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    expect(screen.getByRole("button", { name: "要件を確定する" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(await screen.findByText(/要件がまとまりました/)).toBeTruthy();
    expect(screen.queryByText(/Must \d/)).toBeNull();
  });
});
