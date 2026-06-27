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

// 緋 = 矛盾 / 黄土 = 抜け（05-detection.md / 08-analysis.md のトークン）。
const DETECTION_PRESENTATION: Record<DetectionKind, KindPresentation> = {
  contradiction: {
    color: "#D2564B", // 緋
    // バッジ表記は Figma 正本に合わせて短く「矛盾」。説明は ariaLabel で補う。
    label: "矛盾",
    icon: "⚠",
    ariaLabel: "矛盾を検知",
  },
  gap: {
    color: "#E0A93B", // 黄土
    label: "抜け",
    icon: "◇",
    ariaLabel: "抜け（未定義）を検知",
  },
};

export function detectionPresentation(kind: DetectionKind): KindPresentation {
  return DETECTION_PRESENTATION[kind];
}

// 要件カテゴリの表示（08/09 のチップ・セクション用）。色は補助、ラベル＋アイコンが主。
const CATEGORY_PRESENTATION: Record<string, KindPresentation> = {
  functional: { color: "#2F6FED", label: "機能", icon: "⚙", ariaLabel: "機能要件" },
  non_functional: {
    color: "#6B47C7",
    label: "非機能",
    icon: "◎",
    ariaLabel: "非機能要件",
  },
  constraint: { color: "#8A8D91", label: "制約", icon: "▣", ariaLabel: "制約" },
  scope: { color: "#1F9E8B", label: "境界", icon: "▢", ariaLabel: "スコープ・境界" },
  open_question: {
    color: "#E0A93B",
    label: "未解決",
    icon: "?",
    ariaLabel: "未解決の問い",
  },
};

const UNKNOWN_CATEGORY: KindPresentation = {
  color: "#8A8D91",
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
