"use client";

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import { useInterviewMode } from "@/lib/interviewMode";
import type { Detection, Requirement } from "@/lib/realtime/types";

import { DeepDiveList } from "./DeepDiveList";
import { RequirementsScrollList } from "./RequirementsScrollList";

export interface RequirementsTabProps {
  requirements: Requirement[];
  deepDive: Detection[];
  onJump?: (detectionId: string) => void;
  focusUnresolved?: boolean;
  onUnresolvedFocusConsumed?: () => void;
}

export function RequirementsTab({
  requirements,
  deepDive,
  onJump,
  focusUnresolved = false,
  onUnresolvedFocusConsumed,
}: RequirementsTabProps) {
  const endUser = useInterviewMode() === "end_user";
  const deepDiveRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusUnresolved) return;
    deepDiveRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    onUnresolvedFocusConsumed?.();
  }, [focusUnresolved, onUnresolvedFocusConsumed]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <h2 className="text-[11px] font-bold text-sanba-gold-text">
        {endUser
          ? "うかがった内容の整理（閲覧のみ）"
          : "要件絵巻（MoSCoW・確信度/出所つき・閲覧のみ）"}
      </h2>

      <RequirementsScrollList
        requirements={requirements}
        emptyText={
          endUser
            ? "まだありません。お話が進むと、ここに整理されていきます。"
            : undefined
        }
      />

      <h2
        ref={deepDiveRef}
        tabIndex={-1}
        className="mt-1 inline-flex scroll-mt-2 items-center gap-1 text-[12px] font-bold text-sanba-caution"
      >
        <TriangleAlert size={13} aria-hidden />{" "}
        {endUser ? `確認したいこと（残り ${deepDive.length}）` : `深掘り対象（未解消 ${deepDive.length}）`}
      </h2>
      <DeepDiveList detections={deepDive} onJump={onJump} />
    </div>
  );
}
