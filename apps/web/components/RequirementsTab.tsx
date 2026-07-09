"use client";

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";

import { inquiryTreeStats } from "@/lib/realtime/selectors";
import type { InquiryNode, Requirement } from "@/lib/realtime/types";

import { HelpIcon } from "@/components/sanba";
import { InquiryTree } from "./InquiryTree";
import { RequirementsScrollList } from "./RequirementsScrollList";

export interface RequirementsTabProps {
  requirements: Requirement[];
  nodes: InquiryNode[];
  onDrop?: (nodeId: string) => void;
  focusUnresolved?: boolean;
  onUnresolvedFocusConsumed?: () => void;
}

export function RequirementsTab({
  requirements,
  nodes,
  onDrop,
  focusUnresolved = false,
  onUnresolvedFocusConsumed,
}: RequirementsTabProps) {
  const treeRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusUnresolved) return;
    treeRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    onUnresolvedFocusConsumed?.();
  }, [focusUnresolved, onUnresolvedFocusConsumed]);

  const stats = inquiryTreeStats(nodes);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <h2 className="text-[11px] font-bold text-sanba-gold-text">要件一覧（閲覧のみ）</h2>

      <RequirementsScrollList requirements={requirements} />

      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h2
          ref={treeRef}
          tabIndex={-1}
          className="inline-flex scroll-mt-2 items-center gap-1 text-[12px] font-bold text-sanba-caution"
        >
          <TriangleAlert size={13} aria-hidden /> 確認事項ツリー
          <HelpIcon term="確認したいこと" />
        </h2>
        <p className="text-[10.5px] text-sanba-muted">
          {`未解消 ${stats.unresolved} · 解消済 ${stats.resolved} · 深さ ${stats.maxDepth}/5`}
          {stats.maxBranch >= 4 ? ` · 枝 ${stats.maxBranch}/5` : ""}
        </p>
      </div>

      <InquiryTree nodes={nodes} onDrop={onDrop} />
    </div>
  );
}
