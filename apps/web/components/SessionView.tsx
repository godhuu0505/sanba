"use client";


import {
  RoomAudioRenderer,
  useRoomContext,
  useSpeakingParticipants,
  useTrackToggle,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  ACCEPTED_DOC,
  ACCEPTED_IMAGE,
  ACCEPTED_VIDEO,
  deleteContextFile,
  exportRequirements,
  fetchContextFiles,
  fetchExportEligibility,
  finalizeSession,
  sendTelemetry,
  uploadContextFile,
  type ExportEligibility,
  type ExportOptions,
  type ExportResult,
  type FinalizeResult,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { importDriveFile, isDriveConfigured, openDrivePicker } from "../lib/googleDrive";
import type { MaterialItem } from "../lib/realtime/selectors";
import { useRealtimeSession } from "../lib/realtime/useRealtimeSession";
import { ConversationSessionView } from "./ConversationSessionView";
import { MaterialSourceSheet } from "./MaterialSourceSheet";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function SessionView({
  sessionId,
  sessionToken,
  readOnly = false,
}: {
  sessionId: string;
  sessionToken: string | null;
  readOnly?: boolean;
}) {
  const { state, metrics, sendText, sendAnswer, sendInquiryDrop } = useRealtimeSession({
    sessionId,
    sessionToken,
    hydrateInquiry: true,
    hydrateAnalysis: true,
  });
  const auth = useAuth();

  const router = useRouter();
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const camera = useTrackToggle({ source: Track.Source.Camera });
  const screenShare = useTrackToggle({ source: Track.Source.ScreenShare });
  const [muted, setMuted] = useState(false);
  const room = useRoomContext();
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState("0:00");
  const [timerRunning, setTimerRunning] = useState(true);
  useEffect(() => {
    if (!timerRunning) return;
    const tick = () => setElapsed(formatElapsed(Date.now() - startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timerRunning, startedAt]);
  const speaking = useSpeakingParticipants();
  const agentSpeaking = speaking.some((p) => !p.isLocal);
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [pending, setPending] = useState<MaterialItem[]>([]);
  const [hydratedMaterials, setHydratedMaterials] = useState<MaterialItem[]>([]);
  const [cancelledIds, setCancelledIds] = useState<ReadonlySet<string>>(() => new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const tempSeq = useRef(0);
  const uploadAborters = useRef<Map<string, AbortController>>(new Map());
  const [uploadAliases, setUploadAliases] = useState<ReadonlyMap<string, string>>(() => new Map());

  useEffect(() => {
    if (readOnly) return;
    let alive = true;
    fetchContextFiles(sessionId, sessionToken)
      .then((snap) => {
        if (!alive) return;
        setHydratedMaterials(
          snap.items.map((f) => ({
            id: f.id,
            name: f.name,
            pct: f.status === "done" ? 100 : 0,
            status: f.status,
            ...(f.extracted ? { extracted: f.extracted } : {}),
          })),
        );
      })
      .catch(() => {
      });
    return () => {
      alive = false;
    };
  }, [sessionId, sessionToken, readOnly]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await startUpload(file);
  }

  async function startUpload(file: File) {
    const tempId = `local:${tempSeq.current++}`;
    const aborter = new AbortController();
    uploadAborters.current.set(tempId, aborter);
    setPending((p) => [...p, { id: tempId, name: file.name, pct: 0, status: "uploading" }]);
    try {
      const res = await uploadContextFile(sessionId, file, sessionToken, aborter.signal);
      if (aborter.signal.aborted) {
        if (res.asset_id) void discardOnServer(res.asset_id);
        return;
      }
      const assetId = res.asset_id ?? tempId;
      const done = res.analysis_pending !== true;
      if (assetId !== tempId) {
        setUploadAliases((prev) => new Map(prev).set(tempId, assetId));
      }
      uploadAborters.current.delete(tempId);
      setCancelledIds((prev) => {
        if (!prev.has(assetId)) return prev;
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
      setPending((p) =>
        p
          .filter((m) => !(m.id === assetId && m.id !== tempId && m.status === "cancelled"))
          .map((m) =>
            m.id === tempId
              ? {
                  id: assetId,
                  name: file.name,
                  pct: done ? 100 : 0,
                  status: done ? "done" : "analyzing",
                }
              : m,
          ),
      );
    } catch (err) {
      if (aborter.signal.aborted) return;
      console.error("material upload failed", err);
      const reason = err instanceof Error ? err.message : "アップロードに失敗しました";
      setPending((p) =>
        p.map((m) => (m.id === tempId ? { ...m, name: `${file.name}（${reason}）`, status: "failed" } : m)),
      );
    } finally {
      uploadAborters.current.delete(tempId);
    }
  }

  function handleCancelMaterial(id: string) {
    const ids = new Set<string>([id]);
    const aliased = uploadAliases.get(id);
    if (aliased) ids.add(aliased);
    for (const [tempId, assetId] of uploadAliases) if (assetId === id) ids.add(tempId);

    const target = pending.find((m) => ids.has(m.id));
    const status = target?.status === "uploading" ? "uploading" : "analyzing";

    let aborted = false;
    for (const cid of ids) {
      const controller = uploadAborters.current.get(cid);
      if (controller) {
        controller.abort();
        aborted = true;
        uploadAborters.current.delete(cid);
      }
    }
    setPending((p) => p.map((m) => (ids.has(m.id) ? { ...m, status: "cancelled" } : m)));
    setCancelledIds((prev) => {
      const next = new Set(prev);
      for (const cid of ids) next.add(cid);
      return next;
    });
    for (const cid of ids) {
      if (!cid.startsWith("local:")) void discardOnServer(cid);
    }
    sendTelemetry(
      sessionId,
      "material.cancel",
      { status, result: aborted ? "aborted" : "discarded" },
      sessionToken,
    );
  }

  async function discardOnServer(assetId: string) {
    try {
      await deleteContextFile(sessionId, assetId, sessionToken);
    } catch (err) {
      console.error("[material] server discard failed", err);
      sendTelemetry(sessionId, "material.cancel", { result: "error" }, sessionToken);
    }
  }

  function openSourceSheet() {
    setSourceError(null);
    setSourceSheetOpen(true);
  }

  async function handleDriveImport() {
    setSourceError(null);
    if (!isDriveConfigured()) {
      setSourceError(
        "Google ドライブ連携はこの環境では利用できません（Google API キーが未設定です）。",
      );
      return;
    }
    const token = await auth.requestDriveAccess();
    if (!token) {
      setSourceError(
        "Google ドライブへのアクセスが許可されていません。もう一度お試しいただくと、再度許可を求めます。",
      );
      return;
    }
    setSourceSheetOpen(false);
    let picked: Awaited<ReturnType<typeof openDrivePicker>>;
    try {
      picked = await openDrivePicker(token);
    } catch (e) {
      console.error("drive picker failed", e);
      openSourceSheet();
      setSourceError("Google ドライブを開けませんでした。時間をおいて再度お試しください。");
      return;
    }
    for (const doc of picked) {
      try {
        const file = await importDriveFile(token, doc);
        await startUpload(file);
      } catch (e) {
        console.error("drive import failed", e);
        setPending((p) => [
          ...p,
          {
            id: `local:${tempSeq.current++}`,
            name: `${doc.name}（Google ドライブから取得できませんでした）`,
            pct: 0,
            status: "failed",
          },
        ]);
      }
    }
  }

  function handleRetryMaterial(id: string) {
    setPending((p) => p.filter((m) => m.id !== id));
    openSourceSheet();
  }

  async function toggleCameraTrack() {
    setSourceError(null);
    try {
      await camera.toggle();
    } catch (e) {
      console.error("camera toggle failed", e);
      setSourceError("カメラを開始できませんでした。ブラウザのカメラ許可をご確認ください。");
    }
  }

  async function toggleScreenShareTrack() {
    setSourceError(null);
    try {
      await screenShare.toggle();
    } catch (e) {
      console.error("screenShare toggle failed", e);
      setSourceError("画面共有を開始できませんでした。共有する画面を選び直してください。");
    }
  }

  function handleExport(options?: ExportOptions): Promise<ExportResult> {
    return exportRequirements(sessionId, sessionToken, options);
  }

  function handleCheckExportEligibility(): Promise<ExportEligibility> {
    return fetchExportEligibility(sessionId, sessionToken);
  }

  function handleFinalize(): Promise<FinalizeResult> {
    return finalizeSession(sessionId, sessionToken);
  }

  function handleSendText(text: string) {
    sendText(text);
  }

  return (
    <>
      <RoomAudioRenderer muted={muted} />
      {}
      {!readOnly && (
        <input
          ref={fileInput}
          type="file"
          accept={`${ACCEPTED_IMAGE},${ACCEPTED_VIDEO},${ACCEPTED_DOC}`}
          onChange={handleFile}
          className="hidden"
        />
      )}
      <ConversationSessionView
        readOnly={readOnly}
        state={state}
        sendAnswer={sendAnswer}
        sendInquiryDrop={sendInquiryDrop}
        micOn={mic.enabled}
        muted={muted}
        agentSpeaking={agentSpeaking}
        onToggleMic={() => void mic.toggle()}
        onToggleMute={() => setMuted((m) => !m)}
        onSendText={handleSendText}
        onExport={handleExport}
        onCheckExportEligibility={handleCheckExportEligibility}
        onFinalize={handleFinalize}
        onAddMaterial={openSourceSheet}
        extraMaterials={pending}
        hydratedMaterials={hydratedMaterials}
        onRetryMaterial={handleRetryMaterial}
        onCancelMaterial={handleCancelMaterial}
        cancelledIds={cancelledIds}
        materialAliases={uploadAliases}
        elapsed={elapsed}
        onLeaveConversation={() => {
          if (mic.enabled) void mic.toggle(false);
          if (camera.enabled) void camera.toggle(false);
          if (screenShare.enabled) void screenShare.toggle(false);
        }}
        onEndSession={() => {
          setTimerRunning(false);
          void room.disconnect();
        }}
        onRestart={() => router.push("/")}
        onNavigateResults={() => router.push(`/results/${sessionId}`)}
        metrics={metrics}
      />

      {}
      {sourceSheetOpen && !readOnly && (
        <MaterialSourceSheet
          onClose={() => setSourceSheetOpen(false)}
          onUpload={() => {
            setSourceSheetOpen(false);
            fileInput.current?.click();
          }}
          onToggleCamera={toggleCameraTrack}
          cameraActive={camera.enabled}
          onToggleScreenShare={toggleScreenShareTrack}
          screenShareActive={screenShare.enabled}
          onDrive={() => void handleDriveImport()}
          onSelectSource={(source) =>
            sendTelemetry(sessionId, "material.source_selected", { source }, sessionToken)
          }
          error={sourceError}
        />
      )}
    </>
  );
}
