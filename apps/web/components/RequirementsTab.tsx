"use client";

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import type { Detection, Requirement } from "@/lib/realtime/types";

import { HelpIcon } from "@/components/sanba";
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
  const deepDiveRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusUnresolved) return;
    deepDiveRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    onUnresolvedFocusConsumed?.();
  }, [focusUnresolved, onUnresolvedFocusConsumed]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <h2 className="text-[11px] font-bold text-sanba-gold-text">要件一覧（閲覧のみ）</h2>

      <RequirementsScrollList requirements={requirements} />

      <h2
        ref={deepDiveRef}
        tabIndex={-1}
        className="mt-1 inline-flex scroll-mt-2 items-center gap-1 text-[12px] font-bold text-sanba-caution"
      >
        <TriangleAlert size={13} aria-hidden />{" "}
        {`確認したいこと（残り ${deepDive.length}）`}
        <HelpIcon term="確認したいこと" />
      </h2>
      <DeepDiveList detections={deepDive} onJump={onJump} />
    </div>
  );
}
