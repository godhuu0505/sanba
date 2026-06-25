// SessionState から画面が必要とする派生ビューを切り出す純粋セレクタ（Issue #101）。
// 3画面が同じ規則で部分集合を取れるよう共通化する。

import { PRIORITY_ORDER } from "./mapping";
import type { SessionState } from "./store";
import type { Detection, Priority, Requirement } from "./types";

/** 未解消の検知のみ（05 のスタック / 08 の補完）。最新（seq 大）が先頭。 */
export function selectOpenDetections(state: SessionState): Detection[] {
  return state.detections.filter((d) => !d.resolved && d.summary !== "").reverse();
}

/** 確定要件のみ（09 のサマリ件数・MoSCoW）。 */
export function selectConfirmedRequirements(state: SessionState): Requirement[] {
  return state.requirements.filter((r) => r.status === "confirmed");
}

/** MoSCoW でグルーピング（09 要件絵巻のセクション）。 */
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

/** 09 のスタッツ 3 連（実データ由来。session.completed があれば優先）。 */
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

// ── ミニ状況（常時表示）─────────────────────────────────────────────
// 仕様: docs/design/conversation-experience-v2.md §2（◆要件 N ・ ⚠未確定 N ・ 📎資料 N）。

/** selectMiniStatus が必要とする SessionState の構造的サブセット（テスト容易性のため）。 */
export interface MiniStatusInput {
  requirements: readonly unknown[];
  detections: readonly { resolved: boolean }[];
  analysis: readonly { pct: number }[];
}

export interface MiniStatus {
  /** ◆要件 N（要件絵巻の件数）。 */
  requirements: number;
  /** ⚠未確定 N（未解消の検知＝深掘り対象）。 */
  unresolved: number;
  /** 📎資料 N（投入済み素材）。 */
  materials: number;
  /** 解析中の素材があるか（pct < 100）。 */
  analyzing: boolean;
}

/** 会話シェル上部のミニ状況を導出する。 */
export function selectMiniStatus(s: MiniStatusInput): MiniStatus {
  return {
    requirements: s.requirements.length,
    unresolved: s.detections.filter((d) => !d.resolved).length,
    materials: s.analysis.length,
    analyzing: s.analysis.some((a) => a.pct < 100),
  };
}
