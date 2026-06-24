"use client";

// セッション中の画面束（03/04/05 → 08 → 09）。Issue #95/#96/#97 を #101/#102 の
// 共有 realtime 基盤に結線する。購読・整列・冪等・ハイドレーション・送信はすべて
// useRealtimeSession に集約され、各画面は state とコールバックを受け取るだけ。

import { BarVisualizer, useVoiceAssistant } from "@livekit/components-react";
import { useState } from "react";
import { exportRequirements, type ExportResult } from "../lib/api";
import { useRealtimeSession } from "../lib/realtime/useRealtimeSession";
import { AnalysisView } from "./AnalysisView";
import { DetectionSheet } from "./DetectionSheet";
import { MaterialView } from "./MaterialView";
import { RequirementScroll } from "./RequirementScroll";

type Screen = "live" | "material" | "analysis" | "scroll";

const PHASE_LABEL: Record<string, string> = {
  idle: "待機中",
  listening: "聴いています…",
  recognizing: "認識しています…",
  deliberating: "検討しています…",
};

export function SessionView({
  sessionId,
  sessionToken,
}: {
  sessionId: string;
  sessionToken: string | null;
}) {
  const { state, metrics, sendSelection } = useRealtimeSession({
    sessionId,
    sessionToken,
    hydrateDetections: true,
  });
  const [screen, setScreen] = useState<Screen>("live");

  function handleExport(): Promise<ExportResult> {
    return exportRequirements(sessionId, sessionToken);
  }

  return (
    <div>
      <nav style={navRow}>
        <NavTab label="問答" active={screen === "live"} onClick={() => setScreen("live")} />
        <NavTab
          label="素材"
          active={screen === "material"}
          onClick={() => setScreen("material")}
        />
        <NavTab
          label="解析"
          active={screen === "analysis"}
          onClick={() => setScreen("analysis")}
        />
        <NavTab
          label="要件絵巻"
          active={screen === "scroll"}
          onClick={() => setScreen("scroll")}
        />
      </nav>

      {screen === "live" && (
        <LiveScreen phase={state.phase} agentsActive={state.agentsActive} transcript={state.transcript} />
      )}
      {screen === "material" && <MaterialView />}
      {screen === "analysis" && (
        <AnalysisView state={state} onNext={() => setScreen("scroll")} />
      )}
      {screen === "scroll" && <RequirementScroll state={state} onExport={handleExport} />}

      {/* 検知ボトムシートは画面を問わず最前面にせり上げる（核体験・最小割り込み）。 */}
      <DetectionSheet state={state} onSelect={sendSelection} />

      {/* 観測性: 受信状況を控えめに可視化（取りこぼし調査の足がかり）。 */}
      <p style={metricsLine}>
        受信 {metrics.received} ・ 重複 {metrics.duplicates} ・ 破棄 {metrics.dropped} ・ 欠番{" "}
        {metrics.gaps}
      </p>
    </div>
  );
}

function LiveScreen({
  phase,
  agentsActive,
  transcript,
}: {
  phase: string;
  agentsActive: number;
  transcript: { utterance_id: string; speaker: string; text: string; final: boolean }[];
}) {
  const { state: voiceState, audioTrack } = useVoiceAssistant();
  return (
    <div>
      <p style={{ fontSize: 15 }}>
        ◉ {PHASE_LABEL[phase] ?? phase}
        {agentsActive > 0 && (
          <span style={{ color: "#6B47C7" }}> ・ {agentsActive}体が検討中</span>
        )}
      </p>
      <BarVisualizer state={voiceState} trackRef={audioTrack} style={{ height: 80 }} />
      <div style={{ marginTop: 12 }}>
        {transcript.slice(-6).map((t) => (
          <p
            key={t.utterance_id}
            style={{ margin: "4px 0", fontSize: 14, opacity: t.final ? 1 : 0.5 }}
          >
            <strong>{t.speaker}:</strong> {t.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function NavTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      style={{
        flex: 1,
        padding: "8px 0",
        fontSize: 14,
        fontWeight: active ? 700 : 400,
        border: "none",
        borderBottom: active ? "2px solid #2F6FED" : "2px solid transparent",
        background: "none",
        color: active ? "#2F6FED" : "#666",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

const navRow = {
  display: "flex",
  gap: 4,
  borderBottom: "1px solid #eee",
  margin: "0 0 16px",
};
const metricsLine = {
  marginTop: 24,
  fontSize: 11,
  color: "#aaa",
  textAlign: "center" as const,
};
