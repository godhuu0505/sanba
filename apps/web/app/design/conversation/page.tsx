"use client";

import { useMemo } from "react";
import { notFound } from "next/navigation";
import { useSearchParams } from "next/navigation";

import { ConversationSessionView } from "@/components/ConversationSessionView";
import { contractEventFixture } from "@/lib/realtime/fixtures";
import { useFixtureSession } from "@/lib/realtime/useRealtimeSession";
import type { ExportEligibility, ExportResult } from "@/lib/api";
import type { ShellTab } from "@/components/ConversationShell";

const noExport = async (): Promise<ExportResult> => ({ exported: false });
const noEligibility = async (): Promise<ExportEligibility> => ({ can_export: true });

export default function ConversationPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const q = useSearchParams();
  const upto = Number(q.get("upto") ?? contractEventFixture.length);
  const events = useMemo(
    () => contractEventFixture.slice(0, Number.isFinite(upto) ? upto : undefined),
    [upto],
  );
  const tab = (q.get("tab") as ShellTab | null) ?? "history";
  const micOn = q.get("mic") !== "off";
  const agentSpeaking = q.get("speaking") === "1";

  const { state } = useFixtureSession(events, { stepMs: 0 });

  return (
    <div key={`${tab}-${upto}-${micOn}-${agentSpeaking}`} data-preview-tab={tab}>
      <ConversationSessionView
        state={state}
        micOn={micOn}
        muted={false}
        agentSpeaking={agentSpeaking}
        micMode="ptt"
        recording
        elapsed="12:46"
        onToggleMic={() => {}}
        onToggleMute={() => {}}
        onSendText={() => {}}
        onExport={noExport}
        onCheckExportEligibility={noEligibility}
        onAddMaterial={() => {}}
      />
    </div>
  );
}
