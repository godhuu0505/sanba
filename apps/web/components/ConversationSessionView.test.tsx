// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InterviewModeProvider } from "@/lib/interviewMode";
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
  // 並びは seq 昇順（末尾＝最新）。問いピンは最新未解消（selectOpenDetections の先頭）を出すため、
  // 「選択肢つき検知が前面」を確かめる既定では options つき d1 を最新（末尾）に置く。
  detections: [
    det({ id: "d2", kind: "gap", summary: "『該当なし』の空状態が未定義。", category: "scope" }),
    det({
      id: "d1",
      summary: "関連度順か新着順か。",
      options: [
        { label: "関連度順にする", value: "relevance" },
        { label: "新着順にする", value: "recency" },
      ],
    }),
  ],
  transcript: [
    { utterance_id: "u1", speaker: "顧客", role: "customer", text: "検索は関連度順で。", final: true },
  ],
  analysis: [{ asset_id: "a1", pct: 40, stage: "OCR", extracted: [], conflicts: [] }],
  question: null,
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
  const sendAnswer = vi.fn();
  render(
    <ConversationSessionView
      state={baseState()}
      sendSelection={sendSelection}
      sendAnswer={sendAnswer}
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
  return { sendSelection, sendAnswer, onToggleMic, onToggleMute, onSendText, onAddMaterial };
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

  it("参考資料タブに selectMaterials 由来の素材行を出す（解析中は詳細導線なし）", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    // baseState の a1 は解析中（pct40）。中身が未確定なので詳細導線は出さない。
    expect(screen.getByLabelText("資料 a1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /詳細を開く/ })).toBeNull();
  });

  it("done 素材の行は詳細導線（ボタン）になる", () => {
    renderView({
      state: baseState({
        analysis: [{ asset_id: "a1", pct: 100, stage: "完了", extracted: [], conflicts: [] }],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    expect(screen.getByRole("button", { name: "資料 a1 の詳細を開く" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "資料 a1 の詳細を開く" }));
    const dialog = screen.getByRole("dialog", { name: "資料の詳細" });
    expect(within(dialog).getByText("3カラム一覧")).toBeTruthy();
    expect(within(dialog).getByText(/検索バーが無いが/)).toBeTruthy();
  });

  it("detection が来ない素材でも詳細で言葉×画の矛盾を確認できる（#202 AC）", () => {
    renderView({
      state: baseState({
        detections: [],
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
    fireEvent.click(screen.getByRole("button", { name: "資料 a1 の詳細を開く" }));
    expect(screen.getByText("図にだけ存在する導線（言及なし）")).toBeTruthy();
  });

  it("再接続後の done 素材（realtime 解析行なし）は詳細で空を断定しない（Codex P2 #1）", () => {
    // state.analysis に無い done 素材（GET context/files 復元相当）。fallback は analysisReady=false。
    renderView({
      state: baseState({ analysis: [] }),
      extraMaterials: [{ id: "h1", name: "復元.png", pct: 100, status: "done", extracted: 3 }],
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    fireEvent.click(screen.getByRole("button", { name: "資料 復元.png の詳細を開く" }));
    const dialog = screen.getByRole("dialog", { name: "資料の詳細" });
    expect(within(dialog).queryByText(/見つかっていません/)).toBeNull();
    expect(within(dialog).getAllByText(/取得できていません/).length).toBeGreaterThan(0);
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

  it("選択肢なし検知（gap）が最新未解消なら要約のみの読み取り専用ピンを出す（#208）", () => {
    const { sendSelection } = renderView({
      state: baseState({
        detections: [
          det({ id: "dc", summary: "古い矛盾の問い", options: [{ label: "選ぶA", value: "a" }] }),
          det({ id: "dg", kind: "gap", summary: "『該当なし』の空状態が未定義。", category: "scope" }),
        ],
      }),
    });
    // gap が最新 → 要約が常時ピンに前面表示（読み取り専用・抜けバッジ付き）。
    // 音声状態インジケータも role="status" を持つため、要約テキストとバッジで特定する。
    expect(screen.getByText("『該当なし』の空状態が未定義。")).toBeTruthy();
    expect(screen.getByLabelText("抜け（未定義）を検知")).toBeTruthy();
    // 読み取り専用: 回答ボタンが無く、古い矛盾の選択肢も前面化しない（最新1件のみ）。
    expect(screen.queryByText("古い矛盾の問い")).toBeNull();
    expect(screen.queryByRole("button", { name: "選ぶA" })).toBeNull();
    expect(sendSelection).not.toHaveBeenCalled();
  });

  it("検知が無ければ通常質問（金枠）を問いピンに出し、回答で sendAnswer を送る（#181）", () => {
    const { sendAnswer } = renderView({
      state: baseState({
        detections: [],
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
    // 回答後は問いピンを畳む（同じ問いは再表示しない）。
    expect(screen.queryByText("並び順は何を既定にしますか")).toBeNull();
  });

  it("選択肢つき検知があるときは検知ピンを優先し、通常質問は出さない（#181）", () => {
    renderView({
      state: baseState({
        question: { id: "q1", prompt: "通常質問は出ない", options: [{ label: "x", value: "x" }] },
      }),
    });
    // baseState の d1（選択肢つき矛盾）が優先される。
    expect(screen.getByText("関連度順か新着順か。")).toBeTruthy();
    expect(screen.queryByText("通常質問は出ない")).toBeNull();
  });

  it("ボトムバーのマイク/消音トグルとテキスト送信が配線される", () => {
    const { onToggleMic, onToggleMute, onSendText } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "マイクをミュート" }));
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

  it("未解消0件なら判定で確定でき、結果へ進む", async () => {
    renderView({ state: baseState({ detections: [] }) });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    // finalize 成功（未指定=解決済み扱い）を待ってから結果へ遷移する。
    expect(await screen.findByText(/要件、産まれました/)).toBeTruthy();
    expect(screen.getByText(/確定要件 1 件/)).toBeTruthy();
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
    // a1 は status を realtime 優先で統合しつつ、表示名は実ファイル名「図面.png」を保つ
    // （realtime 行は asset_id しか持たないため、asset_id 表示には戻さない）。
    // a1 は解析中（pct70）なので行は div（詳細導線なし）。表示名は実ファイル名「図面.png」を保つ。
    expect(screen.getByLabelText("資料 図面.png")).toBeTruthy();
    expect(screen.queryByLabelText("資料 a1")).toBeNull();
    // realtime 未到達のローカル行はそのまま見える。
    expect(screen.getByLabelText("資料 アップ中.png")).toBeTruthy();
  });

  it("中断（✕ 中断）→『中断する』で onCancelMaterial を呼ぶ（#219）", () => {
    const onCancelMaterial = vi.fn();
    renderView({
      // realtime 解析行（asset_id=a1）。これを参考資料タブで中断する。
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
    // ミニ状況の「資料 N」は破棄分を含まず、解析中フラグも消える（pct<100 の analysis 行が
    // 残っていてもヘッダーが「資料 0（解析中）」と矛盾しない）。
    expect(screen.getByRole("button", { name: /資料 0/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /解析中/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    // 破棄済み a1 は遅延 realtime（解析中）が来ても行が出ない。
    expect(screen.queryByLabelText("資料 図面.png")).toBeNull();
    expect(screen.getByText(/まだありません/)).toBeTruthy();
  });

  it("確定（要件を確定する）で onFinalize を呼んでから結果へ進む（#186）", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    renderView({ state: baseState({ detections: [] }), onFinalize });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/要件、産まれました/)).toBeTruthy();
  });

  it("確定が失敗（409 等）したら結果へ進まず判定に留まり理由を出す（#186 / Codex P2）", async () => {
    const onFinalize = vi.fn(async () => {
      throw new Error("finalize failed: 409");
    });
    renderView({ state: baseState({ detections: [] }), onFinalize });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    // 失敗理由が判定画面に出て、結果画面（要件、産まれました）には遷移しない。
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/要件、産まれました/)).toBeNull();
    expect(screen.getByRole("button", { name: "要件を確定する" })).toBeTruthy();
  });

  it("未解消のまま終う（強制終了）では確定しないので onFinalize を呼ばない（#186）", () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 0 }));
    renderView({ onFinalize });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "未解消のまま終う" }));
    expect(onFinalize).not.toHaveBeenCalled();
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
    renderView({ state: baseState({ detections: [] }), onExport });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    const issueBtn = await screen.findByRole("button", { name: /Issue/ });
    fireEvent.click(issueBtn);
    fireEvent.click(issueBtn); // 連打
    expect(onExport).toHaveBeenCalledTimes(1);
    resolve();
  });

  it("深掘りの『会話で確認』で会話履歴タブへ戻す", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "要件絵巻" }));
    expect(screen.queryByText("検索は関連度順で。")).toBeNull();
    const jumps = screen.getAllByRole("button", { name: "会話で確認" });
    fireEvent.click(jumps[0]);
    expect(screen.getByText("検索は関連度順で。")).toBeTruthy();
  });
});

describe("ConversationSessionView（セッション終了後の閲覧モード）", () => {
  afterEach(() => cleanup());

  // 確定（未解消0件）で終了し、結果（08）から「この絵巻を画面で確認する」でシェルへ戻る。
  async function endAndView(props: Partial<React.ComponentProps<typeof ConversationSessionView>> = {}) {
    const handles = renderView({ state: baseState({ detections: [] }), ...props });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    await screen.findByText(/要件、産まれました/);
    fireEvent.click(screen.getByRole("button", { name: /この絵巻を画面で確認する/ }));
    return handles;
  }

  it("終了後の確認ではボトムバー（テキスト入力・消音・マイク）と REC・終了を出さない", async () => {
    await endAndView();
    // シェル（要件絵巻タブ）へは戻る。
    expect(screen.getByRole("tab", { name: "要件絵巻" }).getAttribute("aria-selected")).toBe("true");
    // セッション中専用の会話コントロールは出さない。
    expect(screen.queryByLabelText("テキストで入力")).toBeNull();
    expect(screen.queryByRole("button", { name: "送信" })).toBeNull();
    expect(screen.queryByRole("button", { name: "消音" })).toBeNull();
    expect(screen.queryByRole("button", { name: "マイクをミュート" })).toBeNull();
    expect(screen.queryByText(/REC/)).toBeNull();
    expect(screen.queryByRole("button", { name: "会話を終了" })).toBeNull();
  });

  it("『結果に戻る』で結果（08）へ戻れる", async () => {
    await endAndView();
    fireEvent.click(screen.getByRole("button", { name: "結果に戻る" }));
    expect(screen.getByText(/要件、産まれました/)).toBeTruthy();
  });

  it("終了後の参考資料タブは一覧のみで『＋素材を追加』を出さない", async () => {
    await endAndView({
      state: baseState({
        detections: [],
        analysis: [{ asset_id: "a1", pct: 100, stage: "完了", extracted: [], conflicts: [] }],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "参考資料" }));
    // 素材は閲覧できるが、投入・中断の導線はセッション中のみ。
    expect(screen.getByRole("button", { name: "資料 a1 の詳細を開く" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /素材を追加/ })).toBeNull();
  });

  it("未解消のまま終えた後の確認では問いピンと『会話で確認』を出さない", async () => {
    // baseState は未解消 d1（選択肢つき）・d2 を持つ。強制終了（暫定）で結果へ。
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "未解消のまま終う" }));
    expect(await screen.findByText(/暫定で書き留めました/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /この絵巻を画面で確認する/ }));
    // 選択肢つき検知 d1 が残っていても、回答導線（問いピン）は出さない。
    expect(screen.queryByRole("button", { name: "関連度順にする" })).toBeNull();
    // 深掘り一覧は閲覧できるが「会話で確認」は出さない。
    expect(screen.getByText("『該当なし』の空状態が未定義。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "会話で確認" })).toBeNull();
  });
});

describe("ConversationSessionView（読取専用ゲスト / ADR-0032 決定4）", () => {
  afterEach(() => cleanup());

  it("参考資料タブ・資料ミニ状況・素材追加ボタンを出さない（403 を踏ませない）", () => {
    renderView({ readOnly: true });
    expect(screen.queryByRole("tab", { name: "参考資料" })).toBeNull();
    expect(screen.queryByRole("button", { name: /資料/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /素材を追加/ })).toBeNull();
    // 会話（履歴・要件）タブは従来どおり見える。
    expect(screen.getByRole("tab", { name: "会話履歴" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "要件絵巻" })).toBeTruthy();
  });

  it("会話（選択肢回答）は読取専用でも送れる（realtime write は許可されている）", () => {
    const { sendSelection } = renderView({ readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "関連度順にする" }));
    expect(sendSelection).toHaveBeenCalledWith("d1", "relevance");
  });

  it("確定は finalize API を呼ばずに結果へ進み、Issue 起票 UI を出さない", async () => {
    const onFinalize = vi.fn(async () => ({ finalized: true, confirmed_count: 1 }));
    const onExport = vi.fn(async () => ({ exported: true }));
    renderView({ state: baseState({ detections: [] }), readOnly: true, onFinalize, onExport });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    fireEvent.click(screen.getByRole("button", { name: "要件を確定する" }));
    // finalize は 403 になるため呼ばない（結果への遷移のみ）。
    expect(onFinalize).not.toHaveBeenCalled();
    expect(await screen.findByText(/要件、産まれました/)).toBeTruthy();
    // 起票（export）は 403 になるためボタン自体を出さない。
    expect(screen.queryByRole("button", { name: /Issue/ })).toBeNull();
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
          sendSelection={vi.fn()}
          sendAnswer={vi.fn()}
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

  it("検知バッジが利用者向け文言（食い違い）になり、開発語彙（矛盾）を出さない", () => {
    renderEndUser();
    // baseState の最新検知 d1 は contradiction（選択肢つき）。バッジは「食い違い」。
    expect(screen.getByLabelText(/食い違い/)).toBeTruthy();
    expect(screen.queryByLabelText("矛盾を検知")).toBeNull();
  });

  it("要件タブの見出しから MoSCoW を外し、優先度も利用者の言葉にする", () => {
    renderEndUser();
    fireEvent.click(screen.getByRole("tab", { name: "要件絵巻" }));
    expect(screen.queryByText(/MoSCoW/)).toBeNull();
    expect(screen.getByText("うかがった内容の整理（閲覧のみ）")).toBeTruthy();
    // must セクション見出しは「ぜひ必要」（Must は出さない）。
    expect(screen.getByText("ぜひ必要")).toBeTruthy();
    expect(screen.queryByText(/Must/)).toBeNull();
  });

  it("判定・結果画面も利用者向け文言（確定→伝える / Must 内訳なし）", async () => {
    renderEndUser({ state: baseState({ detections: [] }), readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    fireEvent.click(screen.getByRole("button", { name: "終了する" }));
    // 判定: 「要件を確定する」ではなく「この内容で伝える」。
    expect(screen.queryByRole("button", { name: "要件を確定する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "この内容で伝える" }));
    // 結果: MoSCoW 内訳（Must n ・ Should n）を出さない。
    expect(await screen.findByText("お話の内容を整理できました")).toBeTruthy();
    expect(screen.queryByText(/Must \d/)).toBeNull();
  });
});
