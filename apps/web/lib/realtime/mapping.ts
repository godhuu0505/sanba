
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

import type { HelpTerm } from "@/lib/help";

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
    label: "食い違い",
    Icon: TriangleAlert,
    ariaLabel: "食い違いを検知",
  },
  gap: {
    color: "var(--sanba-caution)",
    label: "確認したい点",
    Icon: CircleDashed,
    ariaLabel: "確認したい点",
  },
  ambiguous: {
    color: "var(--sanba-cat-ambiguous)",
    label: "あいまい",
    Icon: Waves,
    ariaLabel: "あいまいな点",
  },
};

export function detectionPresentation(kind: DetectionKind): KindPresentation {
  return DETECTION_PRESENTATION[kind];
}

const DETECTION_HELP_TERM: Record<DetectionKind, HelpTerm> = {
  contradiction: "食い違い",
  gap: "確認したい点",
  ambiguous: "あいまい",
};

export function detectionHelpTerm(kind: DetectionKind): HelpTerm {
  return DETECTION_HELP_TERM[kind];
}

const CATEGORY_PRESENTATION: Record<string, KindPresentation> = {
  functional: { color: "var(--sanba-select)", label: "機能", Icon: Cog, ariaLabel: "機能" },
  non_functional: {
    color: "var(--sanba-cat-nonfunctional)",
    label: "使い心地",
    Icon: Gauge,
    ariaLabel: "使い心地",
  },
  constraint: { color: "var(--sanba-cat-neutral)", label: "前提", Icon: Lock, ariaLabel: "前提" },
  scope: { color: "var(--sanba-cat-scope)", label: "範囲", Icon: SquareDashed, ariaLabel: "対象範囲" },
  open_question: {
    color: "var(--sanba-caution)",
    label: "確認中",
    Icon: CircleHelp,
    ariaLabel: "確認中",
  },
};

const UNKNOWN_CATEGORY: KindPresentation = {
  color: "var(--sanba-cat-neutral)",
  label: "その他",
  Icon: Diamond,
  ariaLabel: "その他",
};

export function categoryPresentation(category: string): KindPresentation {
  return CATEGORY_PRESENTATION[category] ?? UNKNOWN_CATEGORY;
}

const PRIORITY_LABEL: Record<string, string> = {
  must: "ぜひ必要",
  should: "あると助かる",
  could: "できれば",
  wont: "今回は見送り",
};

export function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[priority] ?? "その他";
}

export const PRIORITY_ORDER: readonly string[] = ["must", "should", "could", "wont"];
