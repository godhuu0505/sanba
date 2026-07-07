
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
  color: string;
  label: string;
  Icon: LucideIcon;
  ariaLabel: string;
}

const DETECTION_PRESENTATION: Record<DetectionKind, KindPresentation> = {
  contradiction: {
    color: "var(--sanba-rec-text)",
    label: "矛盾",
    Icon: TriangleAlert,
    ariaLabel: "矛盾を検知",
  },
  gap: {
    color: "var(--sanba-caution)",
    label: "抜け",
    Icon: CircleDashed,
    ariaLabel: "抜け（未定義）を検知",
  },
  ambiguous: {
    color: "var(--sanba-cat-ambiguous)",
    label: "不明瞭",
    Icon: Waves,
    ariaLabel: "不明瞭な論点を検知",
  },
};

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

const CATEGORY_PRESENTATION: Record<string, KindPresentation> = {
  functional: { color: "var(--sanba-select)", label: "機能", Icon: Cog, ariaLabel: "機能要件" },
  non_functional: {
    color: "var(--sanba-cat-nonfunctional)",
    label: "非機能",
    Icon: Gauge,
    ariaLabel: "非機能要件",
  },
  constraint: { color: "var(--sanba-cat-neutral)", label: "制約", Icon: Lock, ariaLabel: "制約" },
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
  Icon: Diamond,
  ariaLabel: "要件",
};

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

const PRIORITY_LABEL: Record<string, string> = {
  must: "Must 必須",
  should: "Should 望ましい",
  could: "Could できれば",
  wont: "Won't 今回は対象外",
};

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

export const PRIORITY_ORDER: readonly string[] = ["must", "should", "could", "wont"];
