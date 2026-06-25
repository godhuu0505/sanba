"use client";

// 要件絵巻タブの「深掘り対象」セクション。未解消の検知（矛盾/抜け）を並べ、会話へ戻す導線を持つ。
// 仕様: docs/design/conversation-experience.md §7 / screens/06-requirements-scroll.md。
// 色は意味の写像（矛盾=緋 / 抜け=黄土）。色のみに依存せずラベル併記（ADR-0017）。

import { detectionPresentation } from "@/lib/realtime/mapping";
import type { Detection } from "@/lib/realtime/types";

export interface DeepDiveListProps {
  /** 未解消の検知（深掘り対象）。 */
  detections: Detection[];
  /** 「会話で確認」押下。該当検知の id を渡す。 */
  onJump: (detectionId: string) => void;
}

export function DeepDiveList({ detections, onJump }: DeepDiveListProps) {
  if (detections.length === 0) {
    return (
      <p className="px-1 py-3 text-[12px] text-[var(--sanba-muted)]">
        未解消はありません（すべて解けました）。
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
            aria-label={`深掘り ${k.ariaLabel}`}
            className="flex flex-col gap-[6px] rounded-[12px] border bg-[#241a0f] px-3 py-[11px]"
            style={{ borderColor: k.color }}
          >
            <div className="flex items-start gap-2">
              <span
                className="rounded-full px-2 py-[2px] text-[10.5px] font-bold text-[var(--sanba-ink)]"
                style={{ backgroundColor: k.color }}
              >
                {k.icon} {k.label}
              </span>
              <p className="flex-1 text-[12.5px] text-[var(--sanba-cream)]">{d.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => onJump(d.id)}
              className="self-start text-[11px] font-bold text-[var(--sanba-gold-text)]"
            >
              会話で確認 ›
            </button>
          </div>
        );
      })}
    </div>
  );
}
