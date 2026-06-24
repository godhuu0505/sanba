"use client";

// 05 検知 — 矛盾/抜けのボトムシート（Issue #97 / 核UI）。
//
// 会話中に矛盾/抜けを検知した瞬間、最小割り込みでシートをせり上げる。判断は人へ返す
// （選択肢提示）。購読・整列・冪等・解消反映は #101 の共有ストアに委譲し、ここは
// 表示と「選択肢タップ → user.selection 送信」だけを担う（衝突回避ルール）。

import { detectionPresentation } from "../lib/realtime/mapping";
import { selectOpenDetections } from "../lib/realtime/selectors";
import type { SessionState } from "../lib/realtime/store";
import type { Detection } from "../lib/realtime/types";
import type { SendSelection } from "../lib/realtime/useRealtimeSession";
import { KindBadge } from "./KindBadge";

export function DetectionSheet({
  state,
  onSelect,
}: {
  state: SessionState;
  onSelect: SendSelection;
}) {
  const open = selectOpenDetections(state);
  if (open.length === 0) return null;

  // 最新（seq 大）を前面に。残りは件数バッジで示す（スタック）。
  const [front, ...rest] = open;
  return (
    <div style={sheetWrap} role="region" aria-label="検知">
      {rest.length > 0 && (
        <div style={stackBadge} aria-label={`未解消の検知 ${open.length}件`}>
          ＋{rest.length} 件の検知
        </div>
      )}
      <DetectionCard detection={front} onSelect={onSelect} expanded />
    </div>
  );
}

function DetectionCard({
  detection,
  onSelect,
  expanded,
}: {
  detection: Detection;
  onSelect: SendSelection;
  expanded: boolean;
}) {
  const p = detectionPresentation(detection.kind);
  return (
    <div style={{ ...cardStyle, borderTop: `3px solid ${p.color}` }}>
      <KindBadge p={p} />
      <p style={{ margin: "10px 0 6px", fontSize: 15, lineHeight: 1.6 }}>
        {detection.summary}
      </p>
      {expanded && detection.refs.length > 0 && (
        // refs（根拠の発話）を辿れる導線。最低でも該当発話 ID を示す（AC）。
        <p style={refsStyle}>
          根拠の発話: {detection.refs.map((r) => `#${r}`).join(" ")}
        </p>
      )}
      {expanded && detection.options && detection.options.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {detection.options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onSelect(detection.id, opt.value)}
              style={optionButton}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const sheetWrap = {
  position: "fixed" as const,
  left: 0,
  right: 0,
  bottom: 0,
  padding: 12,
  maxWidth: 480,
  margin: "0 auto",
  zIndex: 20,
};
const stackBadge = {
  display: "inline-block",
  fontSize: 12,
  color: "#555",
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 999,
  padding: "2px 10px",
  marginBottom: 6,
  boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
};
const cardStyle = {
  background: "#fff",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 -2px 16px rgba(0,0,0,0.12)",
};
const refsStyle = { margin: "4px 0", fontSize: 12, color: "#777" };
const optionButton = {
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 10,
  border: "1px solid #2F6FED",
  background: "#2F6FED",
  color: "#fff",
  cursor: "pointer",
};
