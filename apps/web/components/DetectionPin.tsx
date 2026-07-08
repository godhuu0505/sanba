"use client";

import { HelpIcon } from "@/components/sanba";
import { detectionHelpTerm, detectionPresentation } from "@/lib/realtime/mapping";
import type { DetectionKind } from "@/lib/realtime/types";

export interface DetectionPinProps {
  summary: string;
  kind: DetectionKind;
}

export function DetectionPin({ summary, kind }: DetectionPinProps) {
  const presentation = detectionPresentation(kind);
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-t-2 bg-sanba-surface-strong px-4 py-[11px]"
      style={{ borderTopColor: presentation.color }}
    >
      <span
        aria-label={presentation.ariaLabel}
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
        style={{ backgroundColor: presentation.color }}
      >
        <presentation.Icon size={11} aria-hidden /> {presentation.label}
      </span>
      <HelpIcon term={detectionHelpTerm(kind)} />
      <span className="text-[12px] font-bold text-sanba-gold-text">{summary}</span>
    </div>
  );
}
