"use client";

// 会話フェーズの結線本体（Phase 6 / ADR-0018）。共有 realtime state を
// ConversationShell の 3 タブ（会話履歴 / 参考資料 / 要件絵巻）＋常時ピン＋ボトムバーへ配り、
// 終了 → 07 判定 → 08 結果 までを通す純プレゼン部品（LiveKit 非依存・テスト可能）。
// 購読・整列・ハイドレーション・送信は useRealtimeSession に集約され、ここは state と
// コールバックを受け取るだけ（衝突回避ルール: 購読層は #101 に一本化）。
//
// 既知の seam（契約待ち。本スコープでは結線せず先送り）:
//   - 通常質問（金枠）の選択肢ピン: #181 question.asked / user.answered（現状は検知ドリブンのみ）
//   - テキスト送信先: #185 user.text（onSendText は親が中継）
//   - 素材一覧の name/uploading/failed と再接続復元: #184 GET context/files
//   - 確定の永続書き込み（finalize）: #186（onConfirm は結果遷移のみ・export は実 API）

import { useRef, useState } from "react";

import {
  mergeMaterials,
  selectActiveQuestion,
  selectConfirmedRequirements,
  selectMaterials,
  selectMiniStatus,
  selectOpenDetections,
  type MaterialItem,
} from "@/lib/realtime/selectors";
import type { RealtimeMetricsSnapshot } from "@/lib/realtime/metrics";
import type { SessionState } from "@/lib/realtime/store";
import type { SendAnswer, SendSelection } from "@/lib/realtime/useRealtimeSession";
import type { ExportResult } from "@/lib/api";

import { BottomBar } from "./BottomBar";
import { ChatHistory } from "./ChatHistory";
import { ChoicePin } from "./ChoicePin";
import { ConversationShell, type ShellTab } from "./ConversationShell";
import { DetectionPin } from "./DetectionPin";
import { EndConfirmDialog } from "./EndConfirmDialog";
import { JudgmentGate } from "./JudgmentGate";
import { MaterialsList } from "./MaterialsList";
import { RequirementsTab } from "./RequirementsTab";
import { ResultView } from "./ResultView";

export interface ConversationSessionViewProps {
  state: SessionState;
  /** 検知カードの回答を agent へ送る（契約 §4.5）。 */
  sendSelection: SendSelection;
  /** 通常質問（金枠）の回答を agent へ送る（契約 §4.5 / #181）。 */
  sendAnswer?: SendAnswer;
  /** マイク入力 ON か（LiveKit local track）。 */
  micOn: boolean;
  /** 音声出力の消音中か。 */
  muted: boolean;
  onToggleMic: () => void;
  onToggleMute: () => void;
  /** テキスト送信（#185 user.text を親が中継するまでの seam）。 */
  onSendText: (text: string) => void;
  /** 要件を GitHub Issue 等へ書き出す（08 結果・既存 API）。 */
  onExport: () => Promise<ExportResult>;
  /**
   * 07 判定の「確定」を永続化する（#186）。確定スナップショットを書き込む。
   * 失敗しても結果画面への遷移は止めない（UX を阻害しない・親がログに残す）。
   */
  onFinalize?: () => Promise<unknown>;
  /** 「＋ 素材を追加」（05-2 手段選択 / アップロード。親が所有・必須で偽ボタンを作らない）。 */
  onAddMaterial: () => void;
  /**
   * realtime の analysis 反映前に投入直後の素材を見せるローカル行（アップロード中/失敗）。
   * 同 asset_id の realtime 行が来たらそちらを優先（#184 のハイドレーションが入るまでの橋渡し）。
   */
  extraMaterials?: MaterialItem[];
  /**
   * GET context/files（#184）由来の復元素材。リロード/再接続でローカル行が消えても
   * 実ファイル名・状態を取り戻す土台。realtime の analysis 行とは asset_id で統合する。
   */
  hydratedMaterials?: MaterialItem[];
  /** 失敗素材の再試行（親が再アップロードへ）。 */
  onRetryMaterial?: (id: string) => void;
  /** 会話フェーズを離れる（終了→判定）瞬間。親はここでマイク送信を止める。 */
  onLeaveConversation?: () => void;
  /** 「新しい問答を始める」。 */
  onRestart?: () => void;
  /** 受信状況の観測値（取りこぼし調査の足場・CLAUDE.md 原則3）。 */
  metrics?: RealtimeMetricsSnapshot;
  recording?: boolean;
  elapsed?: string;
}

type Phase = "shell" | "judgment" | "result";

export function ConversationSessionView({
  state,
  sendSelection,
  sendAnswer,
  micOn,
  muted,
  onToggleMic,
  onToggleMute,
  onSendText,
  onExport,
  onFinalize,
  onAddMaterial,
  extraMaterials,
  hydratedMaterials,
  onRetryMaterial,
  onLeaveConversation,
  onRestart,
  metrics,
  recording = true,
  elapsed,
}: ConversationSessionViewProps) {
  const [phase, setPhase] = useState<Phase>("shell");
  const [tab, setTab] = useState<ShellTab>("history");
  const [endOpen, setEndOpen] = useState(false);
  const [provisional, setProvisional] = useState(false);
  // 確定（finalize）失敗時のメッセージ（#186 / Codex P2）。失敗なら結果へ進めず判定に留める。
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  // 回答済みの通常質問 ID（#181）。検知の resolved 相当のサーバ echo が無いため、
  // 回答後はローカルで問いピンを畳む（次の question.asked が新 ID で前面に出る）。
  const [answeredQuestions, setAnsweredQuestions] = useState<ReadonlySet<string>>(new Set());
  // Issue 起票の二重送信を同期的に防ぐ（/export は毎回 GitHub Issue を作るため連打で重複起票になる）。
  const exportingRef = useRef(false);
  // 確定（finalize）の二重送信を同期的に防ぐ（#186）。
  const finalizingRef = useRef(false);

  const baseMini = selectMiniStatus(state);
  const openDetections = selectOpenDetections(state);
  const confirmed = selectConfirmedRequirements(state);

  // 復元（#184）＋投入直後のローカル行（uploading/failed）＋ realtime 解析行を asset_id で統合。
  // 状態は realtime 最優先、表示名は実ファイル名（hydrated/local）を asset_id より優先する。
  const realtimeMaterials = selectMaterials(state);
  const materials = mergeMaterials(realtimeMaterials, extraMaterials ?? [], hydratedMaterials ?? []);

  // 統合後の素材をミニ状況の件数・解析中フラグに反映する（ヘッダーの「📎資料 N」と一致させる）。
  const mini = {
    ...baseMini,
    materials: materials.length,
    analyzing:
      baseMini.analyzing ||
      materials.some((m) => m.status === "uploading" || m.status === "analyzing"),
  };

  function leaveConversationTo(next: Phase) {
    onLeaveConversation?.();
    setPhase(next);
  }

  // 問いピンは「未解消検知（緋/黄土）」を最新優先で1件、常時前面に出す（検知は緊急度が高い）。
  // 選択肢あり: 回答付き ChoicePin。選択肢なし（detection.gap 等）: 要約のみの読み取り専用
  // DetectionPin（#208。旧 find(options>0) は最新の gap を読み飛ばし、件数バッジを開くまで
  // 気づけなかった）。検知が無ければ通常質問（金枠 / #181）を出す。
  const activeDetection = openDetections[0];
  const activeChoice =
    activeDetection && activeDetection.options && activeDetection.options.length > 0
      ? activeDetection
      : null;
  const activeGap = activeDetection && !activeChoice ? activeDetection : null;
  const askedQuestion = selectActiveQuestion(state);
  const activeQuestion =
    !activeDetection && askedQuestion && !answeredQuestions.has(askedQuestion.id)
      ? askedQuestion
      : null;

  // 深掘り/判定の「会話で確認」: 会話履歴タブへ戻す。問いピンは未解消検知を最新優先で
  // 自動表示するため、該当検知が選択肢つきなら戻った先で前面に出る。検知 ID を使った
  // 個別ハイライト/自動スクロールは follow-up（#181 の question 再提示と併せて）。
  function jumpToConversation() {
    setPhase("shell");
    setTab("history");
  }

  // ── 07 判定 ─────────────────────────────────────────────
  if (phase === "judgment") {
    return (
      <JudgmentGate
        unresolved={mini.unresolved}
        detections={openDetections}
        error={finalizeError ?? undefined}
        onBack={() => setPhase("shell")}
        onForceEnd={() => {
          setProvisional(true);
          setPhase("result");
        }}
        onConfirm={() => {
          // 確定スナップショットを finalize API へ書き込む（#186）。成功を待ってから結果へ
          // 遷移し、失敗（409: 未解消残り / 401 等）なら判定画面に留めて理由を出す（Codex P2）。
          // finalize 未指定（テスト等）は解決済み扱いでそのまま遷移する。二重確定は ref で防ぐ。
          if (finalizingRef.current) return;
          finalizingRef.current = true;
          setFinalizeError(null);
          Promise.resolve(onFinalize?.())
            .then(() => {
              setProvisional(false);
              setPhase("result");
            })
            .catch((e) => {
              console.error("finalize failed", e);
              setFinalizeError(
                "確定できませんでした。未解消の項目が残っていないか確かめ、再度お試しください。",
              );
            })
            .finally(() => {
              finalizingRef.current = false;
            });
        }}
        onJump={jumpToConversation}
      />
    );
  }

  // ── 08 結果 ─────────────────────────────────────────────
  if (phase === "result") {
    const breakdown = {
      must: confirmed.filter((r) => r.priority === "must").length,
      should: confirmed.filter((r) => r.priority === "should").length,
      could: confirmed.filter((r) => r.priority === "could").length,
    };
    return (
      <ResultView
        confirmedCount={confirmed.length}
        breakdown={breakdown}
        provisional={provisional}
        onView={() => {
          setPhase("shell");
          setTab("scroll");
        }}
        onRestart={() => onRestart?.()}
        onExportIssue={
          // confirmed が 0 件のときはボタン自体を出さない（空 Issue 起票防止）。
          confirmed.length > 0
            ? () => {
                // 連打による重複起票を防ぐ（ref で同期ガード）。失敗は握りつぶさずログに残す。
                // success URL / 失敗理由 / busy 表示は #186（finalize）と併せた seam（follow-up）。
                if (exportingRef.current) return;
                exportingRef.current = true;
                void onExport()
                  .catch((e) => console.error("export failed", e))
                  .finally(() => {
                    exportingRef.current = false;
                  });
              }
            : undefined
        }
      />
    );
  }

  // ── 04/05/06 会話シェル ─────────────────────────────────
  const choicePin = activeChoice ? (
    <ChoicePin
      questionId={activeChoice.id}
      question={activeChoice.summary}
      options={(activeChoice.options ?? []).map((o) => ({ label: o.label }))}
      detectionKind={activeChoice.kind}
      onAnswer={(i) => {
        const opt = activeChoice.options?.[i];
        if (opt) sendSelection(activeChoice.id, opt.value);
      }}
    />
  ) : activeGap ? (
    // 選択肢なし検知（gap 等）。要約のみの読み取り専用ピン（#208）。回答導線は持たず、
    // 解消（detection.resolved）または次の検知の到着で差し替わる。
    <DetectionPin summary={activeGap.summary} kind={activeGap.kind} />
  ) : activeQuestion ? (
    // 通常質問（金枠 / #181）。detectionKind なし = 金（通常）。回答で user.answered を返し、
    // ローカルで畳む（次の question.asked が前面化するまで再表示しない）。
    <ChoicePin
      questionId={activeQuestion.id}
      question={activeQuestion.prompt}
      options={activeQuestion.options.map((o) => ({ label: o.label }))}
      onAnswer={(i) => {
        const opt = activeQuestion.options[i];
        if (!opt) return;
        sendAnswer?.(activeQuestion.id, { selectedValue: opt.value });
        setAnsweredQuestions((prev) => new Set(prev).add(activeQuestion.id));
      }}
    />
  ) : undefined;

  return (
    <>
      <ConversationShell
        mini={mini}
        recording={recording}
        elapsed={elapsed}
        tab={tab}
        onTabChange={setTab}
        onEnd={() => setEndOpen(true)}
        choicePin={choicePin}
        bottomBar={
          <BottomBar
            micOn={micOn}
            muted={muted}
            onToggleMic={onToggleMic}
            onToggleMute={onToggleMute}
            onSend={onSendText}
          />
        }
        tabs={{
          history: <ChatHistory transcript={state.transcript} />,
          files: <MaterialsList items={materials} onAdd={onAddMaterial} onRetry={onRetryMaterial} />,
          scroll: (
            <RequirementsTab
              requirements={state.requirements}
              deepDive={openDetections}
              onJump={jumpToConversation}
            />
          ),
        }}
      />

      {/* 観測性: 受信/重複/破棄/欠番を控えめに可視化（取りこぼし調査の足場・CLAUDE.md 原則3）。 */}
      {metrics && (
        <p
          aria-hidden
          className="pointer-events-none fixed bottom-1 left-1 z-40 text-[9px] text-[var(--sanba-muted)] opacity-40"
        >
          受信 {metrics.received}・重複 {metrics.duplicates}・破棄 {metrics.dropped}・欠番 {metrics.gaps}
        </p>
      )}

      {endOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
          <EndConfirmDialog
            unresolved={mini.unresolved}
            onContinue={() => setEndOpen(false)}
            onEnd={() => {
              setEndOpen(false);
              // 会話を離れる: 親がマイク送信を止める（判定/結果画面はボトムバーが無く止められないため）。
              leaveConversationTo("judgment");
            }}
          />
        </div>
      )}
    </>
  );
}
