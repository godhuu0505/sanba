// SessionState から画面が必要とする派生ビューを切り出す純粋セレクタ（Issue #101）。
// 3画面が同じ規則で部分集合を取れるよう共通化する。

import { PRIORITY_ORDER } from "./mapping";
import type { AnalysisState, SessionState } from "./store";
import type { AnalysisVisualConflict, Detection, Priority, Requirement } from "./types";

/** 未解消の検知のみ（05 のスタック / 08 の補完）。最新（seq 大）が先頭。 */
export function selectOpenDetections(state: SessionState): Detection[] {
  return state.detections.filter((d) => !d.resolved && d.summary !== "").reverse();
}

/** 直近の通常質問（金枠 / #181）。選択肢が無ければ問いピンは出さない（自由記述は音声/テキスト）。 */
export function selectActiveQuestion(state: SessionState): SessionState["question"] {
  const q = state.question;
  return q && q.options.length > 0 ? q : null;
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

/**
 * 素材行の状態（MaterialsList と共有）。
 * cancelled（破棄）は #219 の中断確定で付く終端状態。failed と同じく pending の終端だが、
 * 表示・件数からは除く（mergeMaterials がフィルタする）。
 */
export type MaterialStatus = "uploading" | "analyzing" | "done" | "failed" | "cancelled";

/** 既定の空集合（mergeMaterials の cancelledIds 既定値・毎回生成を避ける）。 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

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
 * analysis.progress / analysis.visual の (stage, pct) を素材行ステータスへ写す（#143 / ADR-0023）。
 *
 * - `stage="failed"`: 解析失敗（行に再試行導線を出す）。API は失敗時 pct=100 で送るため、pct より
 *   stage を優先しないと「完了」と誤判定する。
 * - `stage="done"` または visual 受信（pct>=100）: 完了。
 * - それ以外（`received`/`analyzing` 等の途中段階）: 解析中（進捗バー）。
 *
 * analysis イベントは解析開始後にしか届かないため uploading はここでは導出しない（投入直後の
 * local 行・#184 の hydrated 行が担い、mergeMaterials で合流する）。
 */
export function materialStatusFromAnalysis(stage: string, pct: number): MaterialStatus {
  if (stage === "failed") return "failed";
  if (stage === "done" || pct >= 100) return "done";
  return "analyzing";
}

/**
 * 解析状態（analysis.progress / analysis.visual 由来）を素材一覧へ寄せる。
 * ステータスは stage を優先して判定する（failed を「完了」と誤らないため / #143）。
 * 実ファイル名は #184（GET context/files）のハイドレーションで合流させる。
 */
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

// ── 参考資料 詳細（05-1）─────────────────────────────────────────────
// 仕様: docs/design/conversation-experience.md §6（05-1 詳細）/ screens/05-materials.md / Figma 148:2。
// 一覧（selectMaterials）は件数だけ持つ最小ビューに留め、抽出要件の中身と「言葉×画の矛盾」は
// 詳細でだけ surface する（PR #200 で AnalysisView を外した結果、conflicts の表示先が消えていた）。

/** 05-1 資料詳細のビューモデル（抽出要件の中身 + 言葉×画の矛盾を含む）。 */
export interface MaterialDetail {
  id: string;
  /** 表示名（無ければ asset_id）。実ファイル名は呼び出し側が mergeMaterials の name で上書きする。 */
  name: string;
  pct: number;
  status: MaterialStatus;
  /** 抽出した要件（チップ表示）。 */
  extracted: string[];
  /**
   * 言葉×画の矛盾（視覚解析由来）。store 既存形（AnalysisVisualConflict）のまま渡す。
   * detection.* イベントの有無に依らず analysis.visual に保持された矛盾をそのまま surface するため、
   * 「視覚解析のみの矛盾（detection 無し）」もここに含まれる（#202 AC）。
   */
  conflicts: AnalysisVisualConflict[];
  /**
   * 解析結果（analysis.visual）を実際に保持しているか。
   * true = extracted/conflicts は確定値（空なら「無し」と断定してよい）。
   * false = 解析途中、または再接続後で詳細が未取得（#184 未対応）。この場合 extracted/conflicts の
   * 空を「解析結果なし」と断定せず、未取得として扱う（一覧の件数と矛盾させない）。
   */
  analysisReady: boolean;
}

/**
 * 1素材の詳細（05-1）を導出する。抽出要件の中身と言葉×画の矛盾を含む点が一覧（selectMaterials）と異なる。
 * conflicts は analysis.visual（store の AnalysisState.conflicts）を出所にし、detection.* に依存しない。
 * これにより detection が来ない「視覚解析のみの矛盾」も確認できる（#202 AC）。
 * 対象 asset_id の解析状態がまだ無ければ null（呼び出し側で空状態を出す）。
 */
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
    // 完了（analysis.visual で pct=100 に固定）した素材のみ extracted/conflicts を確定値とみなす。
    // 失敗・解析中は確定値ではない（空を「無し」と断定しない）。
    analysisReady: done,
  };
}

/**
 * 複数ソースの素材行を asset_id で統合する（#184 ハイドレーション）。
 *
 * 優先度（後勝ち＝ライブが新しい）: hydrated（GET context/files の復元）< local（投入直後の
 * uploading/failed）< realtime（analysis.progress/visual のライブ状態）。
 * ただし表示名は asset_id ではなく実ファイル名を優先する: hydrated/local が持つ
 * 「id と異なる name」を最優先で採用し、realtime 行（name=asset_id）に上書きされないようにする。
 * 出力順は最初に現れた順（hydrated → local → realtime）。
 *
 * cancelledIds（#219 中断で破棄した asset_id）と status==="cancelled" の行は表示・件数から除く。
 * これにより破棄後に遅延 analysis.* が届いても id を無視して行を復活させない（ゾンビ行防止）。
 */
export function mergeMaterials(
  realtime: readonly MaterialItem[],
  local: readonly MaterialItem[] = [],
  hydrated: readonly MaterialItem[] = [],
  cancelledIds: ReadonlySet<string> = EMPTY_IDS,
): MaterialItem[] {
  const ordered = [...hydrated, ...local, ...realtime];
  // 破棄 id を先に集約する。cancelledIds（呼び出し側のガード）に加え、いずれかのソースが
  // status==="cancelled" を持つ id も破棄とみなす。これで後勝ちマージ（realtime 最優先）で
  // cancelled が analyzing/done に上書きされても復活しない（#219 / Codex P2）。
  const cancelled = new Set(cancelledIds);
  for (const m of ordered) if (m.status === "cancelled") cancelled.add(m.id);
  const byId = new Map<string, MaterialItem>();
  const realName = new Map<string, string>();
  for (const m of ordered) {
    // 実ファイル名（id と異なる name）は先勝ち = hydrated/local が realtime より優先。
    if (!realName.has(m.id) && m.name && m.name !== m.id) realName.set(m.id, m.name);
    // status/pct/extracted は後勝ち = realtime が最優先。
    byId.set(m.id, { ...byId.get(m.id), ...m });
  }
  return [...byId.values()]
    // 中断（破棄）した素材は表示・件数から除く（遅延 analysis.* が来ても id ごと無視）。
    .filter((m) => !cancelled.has(m.id))
    .map((m) => {
      const name = realName.get(m.id);
      return name ? { ...m, name } : m;
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
