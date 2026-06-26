// SessionState から画面が必要とする派生ビューを切り出す純粋セレクタ（Issue #101）。
// 3画面が同じ規則で部分集合を取れるよう共通化する。

import { PRIORITY_ORDER } from "./mapping";
import type { AnalysisState, SessionState } from "./store";
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
// 仕様: docs/design/conversation-experience.md §2（◆要件 N ・ ⚠未確定 N ・ 📎資料 N）。

/** selectMiniStatus が必要とする SessionState の構造的サブセット（テスト容易性のため）。 */
export interface MiniStatusInput {
  requirements: readonly unknown[];
  detections: readonly { resolved: boolean; summary: string }[];
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

// ── 参考資料（05）─────────────────────────────────────────────────────
// 仕様: docs/design/conversation-experience.md §3,§6 / screens/05-materials.md。

/** 素材行の状態（MaterialsList と共有）。 */
export type MaterialStatus = "uploading" | "analyzing" | "done" | "failed";

/** 参考資料タブが描く素材ビューモデル（MaterialsList の props 要素）。 */
export interface MaterialItem {
  id: string;
  /** 表示名（無ければ asset_id）。実ファイル名は #184 GET context/files で補完予定。 */
  name: string;
  /** 進捗 0–100。 */
  pct: number;
  status: MaterialStatus;
  /** 完了時の抽出要件数（任意）。 */
  extracted?: number;
}

/**
 * 解析状態（analysis.progress / analysis.visual 由来）を素材一覧へ寄せる。
 * analysis イベントは解析開始後にしか届かないため、ここで導出できるのは analyzing/done のみ。
 * アップロード中（uploading）・失敗（failed）・実ファイル名は #184（GET context/files）の
 * ハイドレーションで合流させる（本セレクタは契約済みのライブ状態に閉じる）。
 */
export function selectMaterials(s: { analysis: readonly AnalysisState[] }): MaterialItem[] {
  return s.analysis.map((a) => {
    const done = a.pct >= 100;
    const item: MaterialItem = {
      id: a.asset_id,
      name: a.asset_id,
      pct: a.pct,
      status: done ? "done" : "analyzing",
    };
    if (done && a.extracted.length > 0) item.extracted = a.extracted.length;
    return item;
  });
}

/** 会話シェル上部のミニ状況を導出する。 */
export function selectMiniStatus(s: MiniStatusInput): MiniStatus {
  return {
    requirements: s.requirements.length,
    // 深掘り一覧（selectOpenDetections）と同じ規則で数える：未解消かつ summary 到着済み。
    unresolved: s.detections.filter((d) => !d.resolved && d.summary !== "").length,
    materials: s.analysis.length,
    analyzing: s.analysis.some((a) => a.pct < 100),
  };
}
