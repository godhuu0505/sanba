"use client";

// 09 要件絵巻 — セッションの成果物（Issue #96）。
//
// 確定要件を MoSCoW で構造化し、検知の実績とともに一覧する。ループを閉じる起点として
// GitHub Issue 書き戻し（ADR-0007 / POST /export）へ接続する。ハイドレーションで復元される。

import { useState } from "react";
import { categoryPresentation, priorityLabel, PRIORITY_ORDER } from "../lib/realtime/mapping";
import {
  selectConfirmedRequirements,
  selectRequirementsByPriority,
  selectStats,
} from "../lib/realtime/selectors";
import type { SessionState } from "../lib/realtime/store";
import type { ExportResult } from "../lib/api";
import type { Priority, Requirement } from "../lib/realtime/types";
import { KindBadge } from "./KindBadge";

export function RequirementScroll({
  state,
  onExport,
}: {
  state: SessionState;
  /** POST /export を呼ぶ。親が sessionId/sessionToken を束ねて渡す。 */
  onExport: () => Promise<ExportResult>;
}) {
  const byPriority = selectRequirementsByPriority(state);
  const stats = selectStats(state);
  const confirmedCount = selectConfirmedRequirements(state).length;

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const r = await onExport();
      setResult(r);
      if (!r.exported) setError(r.reason ?? "起票に失敗しました");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ paddingBottom: 80 }}>
      <h2 style={{ fontSize: 18, margin: "8px 0 4px" }}>要件絵巻</h2>
      <p style={{ margin: "0 0 12px", color: "#666", fontSize: 13 }}>
        確定 {confirmedCount} ・ 検知 {stats.contradictionsResolved + stats.gapsFound}
      </p>

      <div style={statsRow}>
        <Stat n={stats.contradictionsResolved} label="矛盾解消" />
        <Stat n={stats.gapsFound} label="抜け発見" />
        <Stat n={result?.count ?? confirmedCount} label="Issue化" />
      </div>

      {PRIORITY_ORDER.map((pr) => {
        const group = byPriority[pr as Priority];
        if (group.length === 0) return null;
        return (
          <div key={pr}>
            <div style={sectionLabel}>{priorityLabel(pr)}</div>
            {group.map((r) => (
              <RequirementRow key={r.id} requirement={r} />
            ))}
          </div>
        );
      })}

      <button onClick={handleExport} disabled={busy || confirmedCount === 0} style={ctaButton}>
        {busy ? "起票中…" : `GitHub Issue を作成（${confirmedCount}件）`}
      </button>
      {result?.exported && result.issue_url && (
        <p style={{ fontSize: 14 }}>
          ✅ 起票しました:{" "}
          <a href={result.issue_url} target="_blank" rel="noopener noreferrer">
            {result.issue_url}
          </a>
        </p>
      )}
      {error && (
        <p style={{ color: "crimson", fontSize: 14 }}>
          {error}{" "}
          <button onClick={handleExport} style={retryButton}>
            再試行
          </button>
        </p>
      )}
    </section>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div style={statBox}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{n}</div>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
    </div>
  );
}

function RequirementRow({ requirement }: { requirement: Requirement }) {
  const p = categoryPresentation(requirement.category);
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <KindBadge p={p} />
        {requirement.status === "confirmed" ? (
          <span style={{ fontSize: 12, color: "#1F9E8B" }}>確定</span>
        ) : (
          <span style={{ fontSize: 12, color: "#888" }}>下書き</span>
        )}
        <span style={{ fontSize: 12, color: "#888" }}>
          確信度 {Math.round(requirement.confidence * 100)}%
        </span>
      </div>
      <p style={{ margin: "8px 0 4px", fontSize: 15 }}>{requirement.statement}</p>
      <p style={{ margin: 0, fontSize: 12, color: "#777" }}>
        出所: {requirement.source_speaker || "不明"}
      </p>
    </div>
  );
}

const statsRow = { display: "flex", gap: 10, margin: "8px 0 16px" };
const statBox = {
  flex: 1,
  textAlign: "center" as const,
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 12,
  padding: "10px 0",
};
const card = {
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 12,
  padding: 14,
  margin: "8px 0",
};
const sectionLabel = { fontSize: 13, fontWeight: 700, color: "#444", margin: "16px 0 6px" };
const ctaButton = {
  display: "block",
  width: "100%",
  marginTop: 20,
  padding: "12px 16px",
  fontSize: 16,
  fontWeight: 700,
  borderRadius: 12,
  border: "none",
  background: "#6B47C7",
  color: "#fff",
  cursor: "pointer",
};
const retryButton = {
  background: "none",
  border: "none",
  color: "#1d76db",
  textDecoration: "underline",
  cursor: "pointer",
};
