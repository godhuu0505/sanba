"use client";

// 要件絵巻タブの本文。MoSCoW 区分の要件を**閲覧のみ**で並べ、未解消の深掘り対象を続ける。
// 仕様: docs/design/conversation-experience.md §3,§7 / screens/06-requirements-scroll.md。
// 編集はしない（確定操作は 07 判定 → 08 結果）。

import { useEffect, useRef } from "react";

import { PRIORITY_ORDER, priorityLabel } from "@/lib/realtime/mapping";
import type { Detection, Requirement } from "@/lib/realtime/types";

import { DeepDiveList } from "./DeepDiveList";

export interface RequirementsTabProps {
  requirements: Requirement[];
  /** 未解消の検知（深掘り対象）。 */
  deepDive: Detection[];
  /** 深掘りの「会話で確認」押下。 */
  onJump: (detectionId: string) => void;
  /**
   * ミニ状況「未確定」からの遷移時に true（#195）。深掘り（未解消）対象の見出しへスクロールして
   * 視線を誘導する。要件タブを開いただけ（要件タップ）では false。タブ再マウントで誤発火しない
   * よう、消費後は親が onUnresolvedFocusConsumed で false に戻す（ワンショット）。
   */
  focusUnresolved?: boolean;
  /** focusUnresolved を消費したことを親へ通知（false へ戻す）。 */
  onUnresolvedFocusConsumed?: () => void;
}

function confidenceLabel(c: number): string {
  if (c >= 0.75) return "高";
  if (c >= 0.5) return "中";
  return "低";
}

export function RequirementsTab({
  requirements,
  deepDive,
  onJump,
  focusUnresolved = false,
  onUnresolvedFocusConsumed,
}: RequirementsTabProps) {
  const deepDiveRef = useRef<HTMLHeadingElement>(null);
  // 「未確定」からの遷移時のみ深掘り対象へスクロールし、ワンショットで消費する（#195）。
  // 要件タップ（focusUnresolved=false）や通常のタブ再マウントでは発火しない。
  // jsdom は scrollIntoView 未実装のため optional 呼び出しで安全に no-op になる。
  useEffect(() => {
    if (!focusUnresolved) return;
    deepDiveRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    onUnresolvedFocusConsumed?.();
  }, [focusUnresolved, onUnresolvedFocusConsumed]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <h2 className="text-[11px] font-bold text-[var(--sanba-gold-text)]">
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
                  className="flex flex-col gap-[3px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-3 py-[11px]"
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

      <h2
        ref={deepDiveRef}
        tabIndex={-1}
        className="mt-1 scroll-mt-2 text-[12px] font-bold text-[#8f620c]"
      >
        ⚠ 深掘り対象（未解消 {deepDive.length}）
      </h2>
      <DeepDiveList detections={deepDive} onJump={onJump} />
    </div>
  );
}
