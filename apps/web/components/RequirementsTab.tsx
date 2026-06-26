"use client";

// 要件絵巻タブの本文。MoSCoW 区分の要件を**閲覧のみ**で並べ、未解消の深掘り対象を続ける。
// 仕様: docs/design/conversation-experience.md §3,§7 / screens/06-requirements-scroll.md。
// 編集はしない（確定操作は 07 判定 → 08 結果）。

import { PRIORITY_ORDER, priorityLabel } from "@/lib/realtime/mapping";
import type { Detection, Requirement } from "@/lib/realtime/types";

import { DeepDiveList } from "./DeepDiveList";

export interface RequirementsTabProps {
  requirements: Requirement[];
  /** 未解消の検知（深掘り対象）。 */
  deepDive: Detection[];
  /** 深掘りの「会話で確認」押下。 */
  onJump: (detectionId: string) => void;
}

function confidenceLabel(c: number): string {
  if (c >= 0.75) return "高";
  if (c >= 0.5) return "中";
  return "低";
}

export function RequirementsTab({ requirements, deepDive, onJump }: RequirementsTabProps) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <h2 className="text-[11px] font-bold text-[var(--sanba-gold)]">
        要件絵巻（MoSCoW・確信度/出所つき・閲覧のみ）
      </h2>

      {requirements.length === 0 ? (
        <p className="px-1 py-3 text-[12.5px] text-[var(--sanba-muted)]">
          まだ要件はありません。問答が進むと、ここに育っていきます。
        </p>
      ) : (
        PRIORITY_ORDER.map((pr) => {
          const group = requirements.filter((r) => r.priority === pr);
          if (group.length === 0) return null;
          return (
            <section key={pr} aria-label={priorityLabel(pr)} className="flex flex-col gap-[6px]">
              <h3 className="text-[12px] font-bold text-[var(--sanba-gold-text)]">{priorityLabel(pr)}</h3>
              {group.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-col gap-[3px] rounded-[12px] border border-[var(--sanba-border)] bg-[#1b140b] px-3 py-[11px]"
                >
                  <p className="text-[13px] font-bold text-[var(--sanba-cream)]">{r.statement}</p>
                  <span className="text-[10.5px] text-[var(--sanba-muted)]">
                    確信 {confidenceLabel(r.confidence)}　・　出所 {r.source_speaker}
                  </span>
                </div>
              ))}
            </section>
          );
        })
      )}

      <h2 className="mt-1 text-[12px] font-bold text-[#e0a93b]">
        ⚠ 深掘り対象（未解消 {deepDive.length}）
      </h2>
      <DeepDiveList detections={deepDive} onJump={onJump} />
    </div>
  );
}
