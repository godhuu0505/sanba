"use client";

// 08 解析結果 — 素材から抽出した要件と「言葉×画の矛盾/抜け」（Issue #95）。
//
// マルチモーダル検知（ADR-0004）の成果を要件へ接続し、09 要件絵巻へ送る。
// ハイドレーション（GET /requirements）+ ライブ差分（analysis.visual / requirement.upserted）は
// #101 のストアが合流済みなので、ここは表示と遷移だけを担う。

import { categoryPresentation } from "../lib/realtime/mapping";
import { selectOpenDetections } from "../lib/realtime/selectors";
import type { SessionState } from "../lib/realtime/store";
import type { Requirement } from "../lib/realtime/types";
import { KindBadge } from "./KindBadge";

export function AnalysisView({
  state,
  onNext,
}: {
  state: SessionState;
  onNext: () => void;
}) {
  const detections = selectOpenDetections(state);
  return (
    <section style={{ paddingBottom: 80 }}>
      <h2 style={{ fontSize: 18, margin: "8px 0 16px" }}>解析結果</h2>

      {state.analysis.map((a) => (
        <div key={a.asset_id} style={card}>
          <div style={{ fontSize: 13, color: "#666" }}>
            素材: <code>{a.asset_id}</code>（{a.stage} {a.pct}%）
          </div>
          {a.extracted.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={sectionLabel}>抽出した要件</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {a.extracted.map((e, i) => (
                  <span key={i} style={chip}>
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}
          {a.conflicts.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={sectionLabel}>言葉×画の矛盾</div>
              {a.conflicts.map((c, i) => (
                <div key={i} style={conflictRow}>
                  <KindBadge p={categoryDot("contradiction")} />
                  <span style={{ fontSize: 14 }}>{c.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={sectionLabel}>確定・候補の要件</div>
      {state.requirements.length === 0 && (
        <p style={{ color: "#888", fontSize: 14 }}>まだ要件はありません。</p>
      )}
      {state.requirements.map((r) => (
        <RequirementRow key={r.id} requirement={r} />
      ))}

      {detections.length > 0 && (
        <>
          <div style={sectionLabel}>未解消の検知</div>
          {detections.map((d) => (
            <div key={d.id} style={conflictRow}>
              <KindBadge p={categoryDot(d.kind)} />
              <span style={{ fontSize: 14 }}>{d.summary}</span>
            </div>
          ))}
        </>
      )}

      <button onClick={onNext} style={ctaButton}>
        要件の結果を見る →
      </button>
    </section>
  );
}

function RequirementRow({ requirement }: { requirement: Requirement }) {
  const p = categoryPresentation(requirement.category);
  // 出所（発話者／素材の領域）を辿れるよう citations と source_speaker を併記（AC / ADR-0008 #3）。
  const cite = requirement.citations.map((c) => `${c.kind}:${c.ref}`).join(", ");
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <KindBadge p={p} />
        <span style={{ fontSize: 12, color: "#888" }}>確信度 {Math.round(requirement.confidence * 100)}%</span>
      </div>
      <p style={{ margin: "8px 0 4px", fontSize: 15 }}>{requirement.statement}</p>
      <p style={{ margin: 0, fontSize: 12, color: "#777" }}>
        出所: {requirement.source_speaker || "不明"}
        {cite && ` ・ ${cite}`}
      </p>
    </div>
  );
}

// 矛盾=朱/抜け=黄土/不明瞭=鈍色の点（KindBadge を流用）。検知の色トークン（白地向け）に合わせる（#182）。
function categoryDot(kind: "contradiction" | "gap" | "ambiguous") {
  if (kind === "contradiction")
    return { color: "#C43A20", label: "言葉×画の矛盾", icon: "⚠", ariaLabel: "言葉と画の矛盾" };
  if (kind === "ambiguous")
    return { color: "#5E6B85", label: "不明瞭", icon: "〜", ariaLabel: "不明瞭な論点" };
  return { color: "#9C6B0E", label: "抜け", icon: "◇", ariaLabel: "抜け（未定義）" };
}

const card = {
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 12,
  padding: 14,
  margin: "8px 0",
};
const sectionLabel = { fontSize: 13, fontWeight: 700, color: "#444", margin: "16px 0 6px" };
const chip = {
  fontSize: 13,
  background: "#F1F4F9",
  border: "1px solid #dfe5ee",
  borderRadius: 999,
  padding: "3px 12px",
};
const conflictRow = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 0",
  borderBottom: "1px solid #f2f2f2",
};
const ctaButton = {
  display: "block",
  width: "100%",
  marginTop: 20,
  padding: "12px 16px",
  fontSize: 16,
  fontWeight: 700,
  borderRadius: 12,
  border: "none",
  background: "#177E6F",
  color: "#fff",
  cursor: "pointer",
};
