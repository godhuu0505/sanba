"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  mergeMaterials,
  selectConfirmedRequirements,
  selectGateCount,
  selectMaterialDetail,
  selectMaterials,
  selectMiniStatus,
  type MaterialItem,
} from "@/lib/realtime/selectors";
import type { RealtimeMetricsSnapshot } from "@/lib/realtime/metrics";
import type { SessionState } from "@/lib/realtime/store";
import type { SendInquiryDrop } from "@/lib/realtime/useRealtimeSession";
import type { ExportEligibility, ExportOptions, ExportResult } from "@/lib/api";
import { useAuthOptional } from "@/lib/auth";
import type { MicMode, PttPressProps } from "@/lib/usePushToTalk";

import { BottomBar } from "./BottomBar";
import { ChatHistory } from "./ChatHistory";
import { ConversationShell, type ShellTab } from "./ConversationShell";
import { EndConfirmDialog } from "./EndConfirmDialog";
import { EndProposalCard } from "./EndProposalCard";
import { MaterialDetailSheet } from "./MaterialDetailSheet";
import { MaterialsList } from "./MaterialsList";
import { RequirementsTab } from "./RequirementsTab";
import { ResultView, type IssueExportStatus } from "./ResultView";
import { resolveVoiceStatus, VoiceStatusIndicator, type VoiceStatus } from "./VoiceStatusIndicator";
import { Figure, type FigureState } from "./sanba";

export interface ConversationSessionViewProps {
  state: SessionState;
  readOnly?: boolean;
  sendInquiryDrop?: SendInquiryDrop;
  micOn: boolean;
  muted: boolean;
  agentSpeaking?: boolean;
  micMode?: MicMode;
  onMicModeChange?: (mode: MicMode) => void;
  pttPressed?: boolean;
  pttPressProps?: PttPressProps;
  onToggleMic: () => void;
  onToggleMute: () => void;
  onSendText: (text: string) => void;
  onExport: (options?: ExportOptions) => Promise<ExportResult>;
  onCheckExportEligibility?: () => Promise<ExportEligibility>;
  onFinalize?: (options?: { forced?: boolean }) => Promise<unknown>;
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
  onNavigateResults?: () => void;
  metrics?: RealtimeMetricsSnapshot;
  recording?: boolean;
  elapsed?: string;
}

type Phase = "shell" | "result";

const SIDE_FIGURE_STATE: Record<VoiceStatus, FigureState> = {
  "agent-speaking": "asking",
  listening: "listening",
  muted: "writing",
  idle: "walking",
};

export function ConversationSessionView({
  state,
  readOnly = false,
  sendInquiryDrop,
  micOn,
  muted,
  agentSpeaking,
  micMode,
  onMicModeChange,
  pttPressed,
  pttPressProps,
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
  onNavigateResults,
  metrics,
  recording = true,
  elapsed,
}: ConversationSessionViewProps) {
  const userPicture = useAuthOptional()?.profile?.picture;
  const [phase, setPhase] = useState<Phase>("shell");
  const [tab, setTab] = useState<ShellTab>("history");
  const [endOpen, setEndOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [focusDeepDive, setFocusDeepDive] = useState(false);
  const exportingRef = useRef(false);
  const [issueExport, setIssueExport] = useState<IssueExportStatus>({ status: "idle" });
  const [issueDisabledReason, setIssueDisabledReason] = useState<string | null>(null);
  const eligibilityRequestedRef = useRef(false);
  const [endProposalDismissed, setEndProposalDismissed] = useState(false);
  const [autoFinalizing, setAutoFinalizing] = useState(false);
  const finalizingRef = useRef(false);

  const baseMini = selectMiniStatus(state);
  const gateCount = selectGateCount(state);
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

  function jumpToConversation() {
    setPhase("shell");
    setTab("history");
  }

  const endProvisional = useCallback(async () => {
    setEnded(true);
    if (!readOnly) {
      try {
        await Promise.resolve(onFinalize?.({ forced: true }));
      } catch (e) {
        console.error("forced finalize failed", e);
      }
    }
    onEndSession?.();
    if (!readOnly && onNavigateResults) {
      onNavigateResults();
      return;
    }
    setProvisional(true);
    setPhase("result");
  }, [readOnly, onFinalize, onEndSession, onNavigateResults]);

  const finalizeAndFinish = useCallback(async () => {
    if (finalizingRef.current) return;
    if (readOnly) {
      setProvisional(false);
      setEnded(true);
      onEndSession?.();
      setPhase("result");
      return;
    }
    finalizingRef.current = true;
    setAutoFinalizing(true);
    try {
      await Promise.resolve(onFinalize?.());
      setProvisional(false);
      setEnded(true);
      onEndSession?.();
      if (onNavigateResults) {
        onNavigateResults();
        return;
      }
      setPhase("result");
    } catch (e) {
      console.error("finalize failed", e);
      await endProvisional();
    } finally {
      finalizingRef.current = false;
      setAutoFinalizing(false);
    }
  }, [readOnly, onFinalize, onEndSession, onNavigateResults, endProvisional]);

  function finishSession() {
    setEndOpen(false);
    onLeaveConversation?.();
    if (readOnly) {
      setProvisional(mini.unresolved > 0);
      setEnded(true);
      onEndSession?.();
      setPhase("result");
      return;
    }
    if (mini.unresolved === 0) {
      void finalizeAndFinish();
      return;
    }
    void endProvisional();
  }

  useEffect(() => {
    if (state.completed && state.endProposal && phase === "shell" && !ended) {
      void finalizeAndFinish();
    }
  }, [state.completed, state.endProposal, phase, ended, finalizeAndFinish]);

  useEffect(() => {
    if (readOnly || ended) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [readOnly, ended]);

  useEffect(() => {
    setEndProposalDismissed(false);
  }, [state.endProposal]);

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
            ? (choice) => {
                if (exportingRef.current) return;
                exportingRef.current = true;
                setIssueExport({ status: "pending" });
                void onExport(choice)
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

  const voiceStatus = resolveVoiceStatus({
    phase: state.phase,
    micOn,
    muted,
    agentSpeaking,
  });
  const sidePanel = (
    <>
      <Figure
        state={ended ? "writing" : SIDE_FIGURE_STATE[voiceStatus]}
        className="w-[150px] xl:w-[190px]"
        label="サンバのイラスト"
      />
      {!ended && (
        <VoiceStatusIndicator
          phase={state.phase}
          micOn={micOn}
          muted={muted}
          agentSpeaking={agentSpeaking}
          compact
        />
      )}
    </>
  );

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
        sidePanel={sidePanel}
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
              micMode={micMode}
              onMicModeChange={onMicModeChange}
              pttPressed={pttPressed}
              pttPressProps={pttPressProps}
              onToggleMic={onToggleMic}
              onToggleMute={onToggleMute}
              onSend={onSendText}
            />
          )
        }
        tabs={{
          history: (
            <div className="flex flex-col gap-3">
              <ChatHistory
                transcript={state.transcript}
                contextProgress={state.contextProgress}
                materials={materials}
                userPicture={userPicture}
              />
            </div>
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
              nodes={state.inquiryNodes}
              onDrop={ended ? undefined : sendInquiryDrop}
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

      {!ended &&
        !readOnly &&
        state.endProposal &&
        !endProposalDismissed &&
        !state.completed &&
        gateCount === 0 && (
          <div className="fixed inset-x-0 bottom-[92px] z-40 mx-auto w-full max-w-[420px] px-4">
            <EndProposalCard
              requirementCount={state.endProposal.requirement_count}
              materialCount={state.endProposal.material_count}
              busy={autoFinalizing}
              onAgree={() => void finalizeAndFinish()}
              onContinue={() => setEndProposalDismissed(true)}
            />
          </div>
        )}

      {endOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sanba-frame/55 px-4">
          <EndConfirmDialog
            unresolved={mini.unresolved}
            onContinue={() => setEndOpen(false)}
            onEnd={finishSession}
          />
        </div>
      )}
    </>
  );
}
