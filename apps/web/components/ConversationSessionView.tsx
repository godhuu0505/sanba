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

import { useState } from "react";

import {
  selectConfirmedRequirements,
  selectMaterials,
  selectMiniStatus,
  selectOpenDetections,
} from "@/lib/realtime/selectors";
import type { RealtimeMetricsSnapshot } from "@/lib/realtime/metrics";
import type { SessionState } from "@/lib/realtime/store";
import type { SendSelection } from "@/lib/realtime/useRealtimeSession";
import type { ExportResult } from "@/lib/api";

import { BottomBar } from "./BottomBar";
import { ChatHistory } from "./ChatHistory";
import { ChoicePin } from "./ChoicePin";
import { ConversationShell, type ShellTab } from "./ConversationShell";
import { EndConfirmDialog } from "./EndConfirmDialog";
import { JudgmentGate } from "./JudgmentGate";
import { MaterialsList } from "./MaterialsList";
import { RequirementsTab } from "./RequirementsTab";
import { ResultView } from "./ResultView";

export interface ConversationSessionViewProps {
  state: SessionState;
  /** 検知カードの回答を agent へ送る（契約 §4.5）。 */
  sendSelection: SendSelection;
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
  /** 「＋ 素材を追加」（05-2 手段選択 / アップロード。親が所有・必須で偽ボタンを作らない）。 */
  onAddMaterial: () => void;
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
  micOn,
  muted,
  onToggleMic,
  onToggleMute,
  onSendText,
  onExport,
  onAddMaterial,
  onRestart,
  metrics,
  recording = true,
  elapsed,
}: ConversationSessionViewProps) {
  const [phase, setPhase] = useState<Phase>("shell");
  const [tab, setTab] = useState<ShellTab>("history");
  const [endOpen, setEndOpen] = useState(false);
  const [provisional, setProvisional] = useState(false);

  const mini = selectMiniStatus(state);
  const openDetections = selectOpenDetections(state);
  const confirmed = selectConfirmedRequirements(state);

  // 問いピンは「選択肢を持つ未解消検知（緋/黄土）」を最新優先で1件出す。
  // 通常質問（金枠）の選択肢は #181 まで送られてこないため、本スコープでは検知ドリブンのみ。
  const activeChoice = openDetections.find((d) => d.options && d.options.length > 0);

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
        onBack={() => setPhase("shell")}
        onForceEnd={() => {
          setProvisional(true);
          setPhase("result");
        }}
        onConfirm={() => {
          // TODO(#186): 確定スナップショットを finalize API へ書き込む。
          setProvisional(false);
          setPhase("result");
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
        onExportIssue={() => {
          // 失敗は握りつぶさずログに残す（success/error の画面表示は #186 以降の seam）。
          void onExport().catch((e) => console.error("export failed", e));
        }}
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
          files: <MaterialsList items={selectMaterials(state)} onAdd={onAddMaterial} />,
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
              setPhase("judgment");
            }}
          />
        </div>
      )}
    </>
  );
}
