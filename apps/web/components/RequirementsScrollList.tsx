"use client";

import { PRIORITY_ORDER, priorityLabel } from "@/lib/realtime/mapping";
import type { Requirement } from "@/lib/realtime/types";

function confidenceLabel(c: number): string {
  if (c >= 0.75) return "高";
  if (c >= 0.5) return "中";
  return "低";
}

export interface RequirementsScrollListProps {
  requirements: Requirement[];
  emptyText?: string;
}

export function RequirementsScrollList({
  requirements,
  emptyText = "まだ要件はありません。問答が進むと、ここに育っていきます。",
}: RequirementsScrollListProps) {
  if (requirements.length === 0) {
    return <p className="px-1 py-3 text-[12.5px] text-sanba-muted">{emptyText}</p>;
  }
  return (
    <>
      {PRIORITY_ORDER.map((pr) => {
        const group = requirements.filter((r) => r.priority === pr);
        if (group.length === 0) return null;
        return (
          <section
            key={pr}
            aria-label={priorityLabel(pr)}
            className="flex flex-col gap-[6px]"
          >
            <h3 className="text-[12px] font-bold text-sanba-gold-text">
              {priorityLabel(pr)}
            </h3>
            {group.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-[3px] rounded-[12px] border border-sanba-border bg-sanba-surface px-3 py-[11px]"
              >
                <p className="text-[13px] font-bold text-sanba-cream">{r.statement}</p>
                <span className="text-[10.5px] text-sanba-muted">
                  確信 {confidenceLabel(r.confidence)}　・　出所 {r.source_speaker}
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
