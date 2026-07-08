"use client";

import { useEffect, useRef, useState } from "react";

import {
  mergeMaterials,
  selectActiveQuestion,
  selectConfirmedRequirements,
  selectMaterialDetail,
  selectMaterials,
  selectMiniStatus,
  selectOpenDetections,
  type MaterialItem,
} from "@/lib/realtime/selectors";
import type { RealtimeMetricsSnapshot } from "@/lib/realtime/metrics";
import type { SessionState } from "@/lib/realtime/store";
import type { SendAnswer, SendSelection } from "@/lib/realtime/useRealtimeSession";
import type { ExportEligibility, ExportResult } from "@/lib/api";

import { BottomBar } from "./BottomBar";
import { ChatHistory } from "./ChatHistory";
import { ChoicePin } from "./ChoicePin";
import { ConversationShell, type ShellTab } from "./ConversationShell";
import { DetectionPin } from "./DetectionPin";
import { EndConfirmDialog } from "./EndConfirmDialog";
import { JudgmentGate } from "./JudgmentGate";
import { MaterialDetailSheet } from "./MaterialDetailSheet";
import { MaterialsList } from "./MaterialsList";
import { RequirementsTab } from "./RequirementsTab";
import { ResultView, type IssueExportStatus } from "./ResultView";
import { VoiceStatusIndicator } from "./VoiceStatusIndicator";

export interface ConversationSessionViewProps {
  state: SessionState;
  readOnly?: boolean;
  sendSelection: SendSelection;
  sendAnswer?: SendAnswer;
  micOn: boolean;
  muted: boolean;
  agentSpeaking?: boolean;
  onToggleMic: () => void;
  onToggleMute: () => void;
  onSendText: (text: string) => void;
  onExport: () => Promise<ExportResult>;
  onCheckExportEligibility?: () => Promise<ExportEligibility>;
  onFinalize?: () => Promise<unknown>;
  onAddMaterial: () => void;
  extraMaterials?: MaterialItem[];
  hydratedMaterials?: MaterialItem[];
  onRetryMaterial?: (id: string) => void;
  onCancelMaterial?: (id: string) => void;
  cancelledIds?: ReadonlySet<string>;
  materialAliases?: ReadonlyMap<string, string>;
  onLeaveConversation?: () => void;
  onEndSession?: () => void;
  onRestart?: () => void;
  metrics?: RealtimeMetricsSnapshot;
  recording?: boolean;
  elapsed?: string;
}

type Phase = "shell" | "judgment" | "result";

export function ConversationSessionView({
  state,
  readOnly = false,
  sendSelection,
  sendAnswer,
  micOn,
  muted,
  agentSpeaking,
  onToggleMic,
  onToggleMute,
  onSendText,
  onExport,
  onCheckExportEligibility,
  onFinalize,
  onAddMaterial,
  extraMaterials,
  hydratedMaterials,
  onRetryMaterial,
  onCancelMaterial,
  cancelledIds,
  materialAliases,
  onLeaveConversation,
  onEndSession,
  onRestart,
  metrics,
  recording = true,
  elapsed,
}: ConversationSessionViewProps) {
  const [phase, setPhase] = useState<Phase>("shell");
  const [tab, setTab] = useState<ShellTab>("history");
  const [endOpen, setEndOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [focusDeepDive, setFocusDeepDive] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [answeredQuestions, setAnsweredQuestions] = useState<ReadonlySet<string>>(new Set());
  const exportingRef = useRef(false);
  const [issueExport, setIssueExport] = useState<IssueExportStatus>({ status: "idle" });
  const [issueDisabledReason, setIssueDisabledReason] = useState<string | null>(null);
  const eligibilityRequestedRef = useRef(false);
  const finalizingRef = useRef(false);

  const baseMini = selectMiniStatus(state);
  const openDetections = selectOpenDetections(state);
  const confirmed = selectConfirmedRequirements(state);

  useEffect(() => {
    if (
      readOnly ||
      phase !== "result" ||
      confirmed.length === 0 ||
      !onCheckExportEligibility ||
      eligibilityRequestedRef.current
    ) {
      return;
    }
    eligibilityRequestedRef.current = true;
    let cancelled = false;
    void onCheckExportEligibility()
      .then((e) => {
        if (!cancelled) {
          setIssueDisabledReason(e.can_export ? null : (e.reason ?? "issue creation failed"));
        }
      })
      .catch(() => {
        if (!cancelled) setIssueDisabledReason(null);
      });
    return () => {
      cancelled = true;
    };
  }, [readOnly, phase, confirmed.length, onCheckExportEligibility]);

  const realtimeMaterials = selectMaterials(state);
  const materials = mergeMaterials(
    realtimeMaterials,
    extraMaterials ?? [],
    hydratedMaterials ?? [],
    cancelledIds,
  );

  const mini = {
    ...baseMini,
    materials: materials.length,
    analyzing: materials.some((m) => m.status === "uploading" || m.status === "analyzing"),
  };

  const detailMaterial = detailId ? materials.find((m) => m.id === detailId) : undefined;
  const detailBase = detailId ? selectMaterialDetail(state, detailId) : null;
  const detail =
    detailBase != null
      ? { ...detailBase, name: detailMaterial?.name ?? detailBase.name }
      : detailMaterial
        ? {
            id: detailMaterial.id,
            name: detailMaterial.name,
            pct: detailMaterial.pct,
            status: detailMaterial.status,
            extracted: [],
            conflicts: [],
            analysisReady: false,
          }
        : null;

  function leaveConversationTo(next: Phase) {
    onLeaveConversation?.();
    setPhase(next);
  }

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

  function jumpToConversation() {
    setPhase("shell");
    setTab("history");
  }

  if (phase === "judgment") {
    return (
      <JudgmentGate
        unresolved={mini.unresolved}
        detections={openDetections}
        error={finalizeError ?? undefined}
        onBack={() => setPhase("shell")}
        onForceEnd={() => {
          setProvisional(true);
          setEnded(true);
          onEndSession?.();
          setPhase("result");
        }}
        onConfirm={() => {
          if (readOnly) {
            setProvisional(false);
            setEnded(true);
            setPhase("result");
            return;
          }
          if (finalizingRef.current) return;
          finalizingRef.current = true;
          setFinalizeError(null);
          Promise.resolve(onFinalize?.())
            .then(() => {
              setProvisional(false);
              setEnded(true);
              onEndSession?.();
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
        requirements={confirmed}
        provisional={provisional}
        summary={state.completed}
        artifacts={state.completed?.artifacts}
        onView={() => {
          setPhase("shell");
          setTab("scroll");
        }}
        onRestart={() => onRestart?.()}
        issueExport={issueExport}
        issueDisabledReason={issueDisabledReason}
        onExportIssue={
          !readOnly && confirmed.length > 0
            ? () => {
                if (exportingRef.current) return;
                exportingRef.current = true;
                setIssueExport({ status: "pending" });
                void onExport()
                  .then((r) =>
                    setIssueExport(
                      r.exported
                        ? { status: "done", url: r.issue_url }
                        : { status: "error", reason: r.reason },
                    ),
                  )
                  .catch((e) => {
                    console.error("export failed", e);
                    setIssueExport({ status: "error" });
                  })
                  .finally(() => {
                    exportingRef.current = false;
                  });
              }
            : undefined
        }
      />
    );
  }

  const choicePin = ended ? undefined : activeChoice ? (
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
    <DetectionPin summary={activeGap.summary} kind={activeGap.kind} />
  ) : activeQuestion ? (
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
        recording={recording && !ended}
        elapsed={elapsed}
        hideMaterials={readOnly}
        review={ended}
        onBackToResult={() => setPhase("result")}
        tab={tab}
        onTabChange={setTab}
        onUnresolvedJump={() => setFocusDeepDive(true)}
        onEnd={ended ? undefined : () => setEndOpen(true)}
        choicePin={choicePin}
        voiceStatus={
          ended ? undefined : (
            <VoiceStatusIndicator
              phase={state.phase}
              micOn={micOn}
              muted={muted}
              agentSpeaking={agentSpeaking}
              compact
            />
          )
        }
        bottomBar={
          ended ? undefined : (
            <BottomBar
              micOn={micOn}
              muted={muted}
              onToggleMic={onToggleMic}
              onToggleMute={onToggleMute}
              onSend={onSendText}
            />
          )
        }
        tabs={{
          history: (
            <ChatHistory
              transcript={state.transcript}
              contextProgress={state.contextProgress}
              materials={materials}
            />
          ),
          files: readOnly ? null : (
            <MaterialsList
              items={materials}
              onAdd={ended ? undefined : onAddMaterial}
              onRetry={ended ? undefined : onRetryMaterial}
              onOpenDetail={setDetailId}
              onCancel={ended ? undefined : onCancelMaterial}
              aliases={materialAliases}
            />
          ),
          scroll: (
            <RequirementsTab
              requirements={state.requirements}
              deepDive={openDetections}
              onJump={ended ? undefined : jumpToConversation}
              focusUnresolved={focusDeepDive}
              onUnresolvedFocusConsumed={() => setFocusDeepDive(false)}
            />
          ),
        }}
      />

      {metrics && (
        <p
          aria-hidden
          className="pointer-events-none fixed bottom-1 left-1 z-40 text-[9px] text-sanba-muted opacity-40"
        >
          受信 {metrics.received}・重複 {metrics.duplicates}・破棄 {metrics.dropped}・欠番 {metrics.gaps}
        </p>
      )}

      {detail && (
        <MaterialDetailSheet
          detail={detail}
          onClose={() => setDetailId(null)}
          onConfirmInConversation={
            ended
              ? undefined
              : () => {
                  setDetailId(null);
                  jumpToConversation();
                }
          }
        />
      )}

      {endOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sanba-frame/55 px-4">
          <EndConfirmDialog
            unresolved={mini.unresolved}
            onContinue={() => setEndOpen(false)}
            onEnd={() => {
              setEndOpen(false);
              leaveConversationTo("judgment");
            }}
          />
        </div>
      )}
    </>
  );
}
