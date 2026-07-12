
import { PRIORITY_ORDER } from "./mapping";
import type { AnalysisState, SessionState } from "./store";
import type {
  AnalysisVisualConflict,
  InquiryKind,
  InquiryNode,
  InquiryStatus,
  Priority,
  Requirement,
} from "./types";

const GATE_KINDS: ReadonlySet<InquiryKind> = new Set<InquiryKind>([
  "contradiction",
  "gap",
  "check",
]);

export function selectInquiryNodes(state: SessionState): InquiryNode[] {
  return state.inquiryNodes;
}

export function selectGateNodes(state: SessionState): InquiryNode[] {
  return state.inquiryNodes.filter((n) => n.status === "open" && GATE_KINDS.has(n.kind));
}

export function selectGateCount(state: SessionState): number {
  return selectGateNodes(state).length;
}

export interface InquiryTreeStats {
  unresolved: number;
  resolved: number;
  dropped: number;
  maxDepth: number;
  maxBranch: number;
}

export function inquiryTreeStats(nodes: readonly InquiryNode[]): InquiryTreeStats {
  let unresolved = 0;
  let resolved = 0;
  let dropped = 0;
  let maxDepth = 0;
  const childCount = new Map<string, number>();
  for (const n of nodes) {
    if (n.status === "dropped") {
      dropped += 1;
      continue;
    }
    if (n.status === "resolved") resolved += 1;
    else if (GATE_KINDS.has(n.kind)) unresolved += 1;
    if (n.depth > maxDepth) maxDepth = n.depth;
    const parent = n.parent_id ?? "__root__";
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }
  let maxBranch = 0;
  for (const c of childCount.values()) if (c > maxBranch) maxBranch = c;
  return { unresolved, resolved, dropped, maxDepth, maxBranch };
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
    contradictionsResolved: state.inquiryNodes.filter(
      (n) => n.kind === "contradiction" && n.status === "resolved",
    ).length,
    gapsFound: state.inquiryNodes.filter((n) => n.kind === "gap").length,
    confirmed: selectConfirmedRequirements(state).length,
  };
}

export { PRIORITY_ORDER };


export interface MiniStatusInput {
  requirements: readonly unknown[];
  inquiryNodes: readonly { status: InquiryStatus; kind: InquiryKind }[];
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
    unresolved: s.inquiryNodes.filter((n) => n.status === "open" && GATE_KINDS.has(n.kind)).length,
    materials: s.analysis.length,
    analyzing: s.analysis.some((a) => a.pct < 100),
  };
}
