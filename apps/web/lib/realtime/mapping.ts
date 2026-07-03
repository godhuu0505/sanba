// 機能名（detector / source_speaker）→ UI 表示への共通マッピング層（Issue #101）。
//
// 契約 §3 注記: ペイロードは機能名で届く。緋=矛盾 / 黄土=抜け のような色は web 側の
// デザイントークンへの写像にすぎない。ここを 1か所に集約し、3画面が同じ規則で
// 「色 + ラベル + アイコン」を出せるようにする。
//
// 重要: **色のみに依存しない**（DoD / 05・08 の AC）。色覚特性に関わらず判別できるよう、
// 必ず label と icon を伴わせる。色は補助。

import type { DetectionKind } from "./types";

export interface KindPresentation {
  /** デザイントークン色（補助）。 */
  color: string;
  /** 機能的な日本語ラベル（主たる識別子）。 */
  label: string;
  /** 色覚非依存のための記号（主たる識別子）。 */
  icon: string;
  /** スクリーンリーダ向けの説明。 */
  ariaLabel: string;
}

// 朱（旧・緋）= 矛盾 / 黄土 = 抜け（05-detection.md / 08-analysis.md のトークン）。
// 値は白地（ADR-0025）でコントラストが立つよう暗めに調整している。
const DETECTION_PRESENTATION: Record<DetectionKind, KindPresentation> = {
  contradiction: {
    color: "#C43A20", // 朱（= --sanba-rec）
    // バッジ表記は Figma 正本に合わせて短く「矛盾」。説明は ariaLabel で補う。
    label: "矛盾",
    icon: "⚠",
    ariaLabel: "矛盾を検知",
  },
  gap: {
    color: "#7D560B", // 黄土（白地向けの暗色）
    label: "抜け",
    icon: "◇",
    ariaLabel: "抜け（未定義）を検知",
  },
  ambiguous: {
    color: "#5E6B85", // 鈍色（朱/黄土/橄欖/金 と判別できるくすんだ藍鼠 / #182・ADR-0022）
    label: "不明瞭",
    // 「〜」で曖昧さを表す。要件カテゴリ open_question の「?」と記号が衝突しないようにする。
    icon: "〜",
    ariaLabel: "不明瞭な論点を検知",
  },
};

export function detectionPresentation(kind: DetectionKind): KindPresentation {
  return DETECTION_PRESENTATION[kind];
}

// 要件カテゴリの表示（08/09 のチップ・セクション用）。色は補助、ラベル＋アイコンが主。
const CATEGORY_PRESENTATION: Record<string, KindPresentation> = {
  // 機能は瑠璃（= --sanba-select）で選択系の青と統一（ADR-0025）。
  functional: { color: "#2A5CDB", label: "機能", icon: "⚙", ariaLabel: "機能要件" },
  non_functional: {
    color: "#6B47C7",
    label: "非機能",
    icon: "◎",
    ariaLabel: "非機能要件",
  },
  constraint: { color: "#6B6E73", label: "制約", icon: "▣", ariaLabel: "制約" },
  scope: { color: "#177E6F", label: "境界", icon: "▢", ariaLabel: "スコープ・境界" },
  open_question: {
    color: "#7D560B",
    label: "未解決",
    icon: "?",
    ariaLabel: "未解決の問い",
  },
};

const UNKNOWN_CATEGORY: KindPresentation = {
  color: "#6B6E73",
  label: "要件",
  icon: "•",
  ariaLabel: "要件",
};

export function categoryPresentation(category: string): KindPresentation {
  return CATEGORY_PRESENTATION[category] ?? UNKNOWN_CATEGORY;
}

// MoSCoW 優先度の表示（09 要件絵巻のセクション）。
const PRIORITY_LABEL: Record<string, string> = {
  must: "Must 必須",
  should: "Should 望ましい",
  could: "Could できれば",
  wont: "Won't 今回は対象外",
};

export function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[priority] ?? priority;
}

/** MoSCoW の表示順。 */
export const PRIORITY_ORDER: readonly string[] = ["must", "should", "could", "wont"];
