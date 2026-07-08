"use client";

import { ChevronRight } from "lucide-react";

import { detectionPresentation } from "@/lib/realtime/mapping";
import type { Detection } from "@/lib/realtime/types";

export interface DeepDiveListProps {
  detections: Detection[];
  onJump?: (detectionId: string) => void;
}

export function DeepDiveList({ detections, onJump }: DeepDiveListProps) {
  if (detections.length === 0) {
    return (
      <p className="px-1 py-3 text-[12px] text-sanba-muted">
        未解消はありません（すべて確認できました）。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[9px]">
      {detections.map((d) => {
        const k = detectionPresentation(d.kind);
        return (
          <div
            key={d.id}
            aria-label={`確認したいこと ${k.ariaLabel}`}
            className="flex flex-col gap-[6px] rounded-[12px] border bg-sanba-surface px-3 py-[11px]"
            style={{ borderColor: k.color }}
          >
            <div className="flex items-start gap-2">
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
                style={{ backgroundColor: k.color }}
              >
                <k.Icon size={11} aria-hidden /> {k.label}
              </span>
              <p className="flex-1 text-[12.5px] text-sanba-cream">{d.summary}</p>
            </div>
            {onJump && (
              <button
                type="button"
                onClick={() => onJump(d.id)}
                className="inline-flex items-center gap-[2px] self-start text-[11px] font-bold text-sanba-gold-text"
              >
                会話で確認 <ChevronRight size={11} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
