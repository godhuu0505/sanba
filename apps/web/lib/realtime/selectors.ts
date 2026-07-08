
import { PRIORITY_ORDER } from "./mapping";
import type { AnalysisState, SessionState } from "./store";
import type {
  AnalysisVisualConflict,
  CoveragePoint,
  Detection,
  Priority,
  Requirement,
} from "./types";

export function selectOpenDetections(state: SessionState): Detection[] {
  return state.detections.filter((d) => !d.resolved && d.summary !== "").reverse();
}

export function selectCheckpointCoverage(state: SessionState): CoveragePoint[] {
  return state.coverage;
}

export function selectActiveQuestion(state: SessionState): SessionState["question"] {
  const q = state.question;
  return q && q.options.length > 0 ? q : null;
}

export function selectConfirmedRequirements(state: SessionState): Requirement[] {
  return state.requirements.filter((r) => r.status === "confirmed");
}

export function selectRequirementsByPriority(
  state: SessionState,
): Record<Priority, Requirement[]> {
  const groups: Record<Priority, Requirement[]> = {
    must: [],
    should: [],
    could: [],
    wont: [],
  };
  for (const r of state.requirements) groups[r.priority].push(r);
  return groups;
}

export interface SessionStats {
  contradictionsResolved: number;
  gapsFound: number;
  confirmed: number;
}

export function selectStats(state: SessionState): SessionStats {
  if (state.completed) {
    return {
      contradictionsResolved: state.completed.contradictions_resolved,
      gapsFound: state.completed.gaps_found,
      confirmed: selectConfirmedRequirements(state).length,
    };
  }
  return {
    contradictionsResolved: state.detections.filter(
      (d) => d.kind === "contradiction" && d.resolved,
    ).length,
    gapsFound: state.detections.filter((d) => d.kind === "gap").length,
    confirmed: selectConfirmedRequirements(state).length,
  };
}

export { PRIORITY_ORDER };


export interface MiniStatusInput {
  requirements: readonly unknown[];
  detections: readonly { resolved: boolean; summary: string }[];
  analysis: readonly { pct: number }[];
}

export interface MiniStatus {
  requirements: number;
  unresolved: number;
  materials: number;
  analyzing: boolean;
}


export type MaterialStatus = "uploading" | "analyzing" | "done" | "failed" | "cancelled";

const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface MaterialItem {
  id: string;
  name: string;
  pct: number;
  status: MaterialStatus;
  extracted?: number;
}

export function materialStatusFromAnalysis(stage: string, pct: number): MaterialStatus {
  if (stage === "failed") return "failed";
  if (stage === "done" || pct >= 100) return "done";
  return "analyzing";
}

export function selectMaterials(s: { analysis: readonly AnalysisState[] }): MaterialItem[] {
  return s.analysis.map((a) => {
    const status = materialStatusFromAnalysis(a.stage, a.pct);
    const item: MaterialItem = {
      id: a.asset_id,
      name: a.asset_id,
      pct: a.pct,
      status,
    };
    if (status === "done" && a.extracted.length > 0) item.extracted = a.extracted.length;
    return item;
  });
}


export interface MaterialDetail {
  id: string;
  name: string;
  pct: number;
  status: MaterialStatus;
  extracted: string[];
  conflicts: AnalysisVisualConflict[];
  analysisReady: boolean;
}

export function selectMaterialDetail(
  s: { analysis: readonly AnalysisState[] },
  assetId: string,
): MaterialDetail | null {
  const a = s.analysis.find((x) => x.asset_id === assetId);
  if (!a) return null;
  const status = materialStatusFromAnalysis(a.stage, a.pct);
  const done = status === "done";
  return {
    id: a.asset_id,
    name: a.asset_id,
    pct: a.pct,
    status,
    extracted: a.extracted,
    conflicts: a.conflicts,
    analysisReady: done,
  };
}

export function mergeMaterials(
  realtime: readonly MaterialItem[],
  local: readonly MaterialItem[] = [],
  hydrated: readonly MaterialItem[] = [],
  cancelledIds: ReadonlySet<string> = EMPTY_IDS,
): MaterialItem[] {
  const ordered = [...hydrated, ...local, ...realtime];
  const cancelled = new Set(cancelledIds);
  for (const m of ordered) if (m.status === "cancelled") cancelled.add(m.id);
  const byId = new Map<string, MaterialItem>();
  const realName = new Map<string, string>();
  for (const m of ordered) {
    if (!realName.has(m.id) && m.name && m.name !== m.id) realName.set(m.id, m.name);
    byId.set(m.id, { ...byId.get(m.id), ...m });
  }
  return [...byId.values()]
    .filter((m) => !cancelled.has(m.id))
    .map((m) => {
      const name = realName.get(m.id);
      return name ? { ...m, name } : m;
    });
}

export function selectMiniStatus(s: MiniStatusInput): MiniStatus {
  return {
    requirements: s.requirements.length,
    unresolved: s.detections.filter((d) => !d.resolved && d.summary !== "").length,
    materials: s.analysis.length,
    analyzing: s.analysis.some((a) => a.pct < 100),
  };
}
