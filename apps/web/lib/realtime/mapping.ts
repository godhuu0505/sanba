// 機能名（detector / source_speaker）→ UI 表示への共通マッピング層（Issue #101）。
//
// 契約 §3 注記: ペイロードは機能名で届く。緋=矛盾 / 黄土=抜け のような色は web 側の
// デザイントークンへの写像にすぎない。ここを 1か所に集約し、3画面が同じ規則で
// 「色 + ラベル + アイコン」を出せるようにする。
//
// 重要: **色のみに依存しない**（DoD / 05・08 の AC）。色覚特性に関わらず判別できるよう、
// 必ず label と icon を伴わせる。色は補助。
// アイコンは lucide-react の線画で統一する（絵文字/幾何グリフは使わない・デザイン方針）。

import {
  CircleDashed,
  CircleHelp,
  Cog,
  Diamond,
  Gauge,
  Lock,
  type LucideIcon,
  SquareDashed,
  TriangleAlert,
  Waves,
} from "lucide-react";

import type { InterviewMode } from "../interviewMode";
import type { DetectionKind } from "./types";

export interface KindPresentation {
  /** デザイントークン色（補助）。 */
  color: string;
  /** 機能的な日本語ラベル（主たる識別子）。 */
  label: string;
  /** 色覚非依存のための lucide アイコン（主たる識別子）。`<p.Icon size={…} aria-hidden />` で描く。 */
  Icon: LucideIcon;
  /** スクリーンリーダ向けの説明。 */
  ariaLabel: string;
}

// 朱（旧・緋）= 矛盾 / 黄土 = 抜け（05-detection.md / 08-analysis.md のトークン）。
// 値は白地（ADR-0025）でコントラストが立つよう暗めに調整している。
const DETECTION_PRESENTATION: Record<DetectionKind, KindPresentation> = {
  contradiction: {
    color: "var(--sanba-rec-text)", // 朱の文字用（= --sanba-rec-text・白地 5.3:1）
    // バッジ表記は Figma 正本に合わせて短く「矛盾」。説明は ariaLabel で補う。
    label: "矛盾",
    Icon: TriangleAlert,
    ariaLabel: "矛盾を検知",
  },
  gap: {
    color: "var(--sanba-caution)", // 黄土（白地向けの暗色）
    label: "抜け",
    // 破線の円＝「未定義（欠けている）」。要件の Diamond・未解決の CircleHelp と判別できる形にする。
    Icon: CircleDashed,
    ariaLabel: "抜け（未定義）を検知",
  },
  ambiguous: {
    color: "var(--sanba-cat-ambiguous)", // 鈍色（朱/黄土/橄欖/金 と判別できるくすんだ藍鼠 / #182・ADR-0022）
    label: "不明瞭",
    // 波形（旧グリフ「〜」の意匠）で曖昧さを表す。open_question の CircleHelp と衝突しないようにする。
    Icon: Waves,
    ariaLabel: "不明瞭な論点を検知",
  },
};

// end_user モード（ADR-0032 / FR-2.4）: 「矛盾」「抜け」等の開発語彙を利用者向けの
// 言い回しへ差し替える。色・アイコンは developer と共有し（色のみ非依存の原則は不変）、
// ラベル・読み上げだけ切替える。
const DETECTION_PRESENTATION_END_USER: Record<DetectionKind, Partial<KindPresentation>> = {
  contradiction: { label: "食い違い", ariaLabel: "お話に食い違いがある点" },
  gap: { label: "確認", ariaLabel: "確認したい点" },
  ambiguous: { label: "あいまい", ariaLabel: "あいまいな点" },
};

export function detectionPresentation(
  kind: DetectionKind,
  mode: InterviewMode = "developer",
): KindPresentation {
  const base = DETECTION_PRESENTATION[kind];
  if (mode !== "end_user") return base;
  return { ...base, ...DETECTION_PRESENTATION_END_USER[kind] };
}

// 要件カテゴリの表示（08/09 のチップ・セクション用）。色は補助、ラベル＋アイコンが主。
const CATEGORY_PRESENTATION: Record<string, KindPresentation> = {
  // 機能は瑠璃（= --sanba-select）で選択系の青と統一（ADR-0025）。歯車＝機能。
  functional: { color: "var(--sanba-select)", label: "機能", Icon: Cog, ariaLabel: "機能要件" },
  non_functional: {
    color: "var(--sanba-cat-nonfunctional)",
    label: "非機能",
    // 計器＝性能・品質特性（非機能）。
    Icon: Gauge,
    ariaLabel: "非機能要件",
  },
  // 錠前＝動かせない前提（制約）。
  constraint: { color: "var(--sanba-cat-neutral)", label: "制約", Icon: Lock, ariaLabel: "制約" },
  // 破線の四角＝対象範囲の枠（境界）。
  scope: { color: "var(--sanba-cat-scope)", label: "境界", Icon: SquareDashed, ariaLabel: "スコープ・境界" },
  open_question: {
    color: "var(--sanba-caution)",
    label: "未解決",
    Icon: CircleHelp,
    ariaLabel: "未解決の問い",
  },
};

const UNKNOWN_CATEGORY: KindPresentation = {
  color: "var(--sanba-cat-neutral)",
  label: "要件",
  // 菱形＝要件そのもの（会話シェルのミニ状況「要件」と同じ意匠）。
  Icon: Diamond,
  ariaLabel: "要件",
};

// end_user モード（FR-2.4）: 「非機能」「スコープ」等の開発語彙を日常語へ寄せる。
const CATEGORY_PRESENTATION_END_USER: Record<string, Partial<KindPresentation>> = {
  functional: { label: "機能", ariaLabel: "機能のこと" },
  non_functional: { label: "使い心地", ariaLabel: "使い心地のこと" },
  constraint: { label: "前提", ariaLabel: "前提のこと" },
  scope: { label: "範囲", ariaLabel: "対象範囲のこと" },
  open_question: { label: "確認中", ariaLabel: "確認中のこと" },
};

export function categoryPresentation(
  category: string,
  mode: InterviewMode = "developer",
): KindPresentation {
  const base = CATEGORY_PRESENTATION[category] ?? UNKNOWN_CATEGORY;
  if (mode !== "end_user") return base;
  return { ...base, label: "要望", ariaLabel: "要望", ...CATEGORY_PRESENTATION_END_USER[category] };
}

// MoSCoW 優先度の表示（09 要件絵巻のセクション）。
const PRIORITY_LABEL: Record<string, string> = {
  must: "Must 必須",
  should: "Should 望ましい",
  could: "Could できれば",
  wont: "Won't 今回は対象外",
};

// end_user モード（FR-2.4）: MoSCoW という内部分類名（Must/Should/...）を露出させない。
// 区分の構造（優先度順の並び）は保ち、名前だけ利用者の言葉に差し替える。
const PRIORITY_LABEL_END_USER: Record<string, string> = {
  must: "ぜひ必要",
  should: "あると助かる",
  could: "できれば",
  wont: "今回は見送り",
};

export function priorityLabel(priority: string, mode: InterviewMode = "developer"): string {
  if (mode === "end_user") return PRIORITY_LABEL_END_USER[priority] ?? "その他";
  return PRIORITY_LABEL[priority] ?? priority;
}

/** MoSCoW の表示順。 */
export const PRIORITY_ORDER: readonly string[] = ["must", "should", "could", "wont"];
