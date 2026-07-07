import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./Button";
import { Chip, type ChipTone } from "./Chip";

export type RequirementStatus = "draft" | "approved" | "rejected";

const STATUS: Record<RequirementStatus, { label: string; tone: ChipTone }> = {
  draft: { label: "下書き", tone: "neutral" },
  approved: { label: "承認済み", tone: "success" },
  rejected: { label: "却下", tone: "danger" },
};

export interface RequirementCardProps extends React.HTMLAttributes<HTMLDivElement> {
  status: RequirementStatus;
  confidence?: React.ReactNode;
  statement?: React.ReactNode;
  meta?: React.ReactNode;
  onRevise?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  showActions?: boolean;
}

export function RequirementCard({
  className,
  status,
  confidence,
  statement,
  meta,
  onRevise,
  onApprove,
  onReject,
  showActions,
  children,
  ...props
}: RequirementCardProps) {
  const s = STATUS[status];
  const hasActions = showActions || onRevise || onApprove || onReject;
  return (
    <div
      className={cn(
        "sanba-wobble flex w-full flex-col gap-[10px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[16px] py-[14px] shadow-[3px_3px_0_var(--sanba-shadow)]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-[10px]">
        <Chip tone={s.tone} solid={status !== "draft"}>
          {s.label}
        </Chip>
        {confidence != null && (
          <span className="text-[12px] text-sanba-muted">{confidence}</span>
        )}
      </div>
      <p className="text-[14px] leading-[1.5] text-sanba-cream">{statement ?? children}</p>
      {meta != null && <p className="text-[12px] text-sanba-muted">{meta}</p>}
      {hasActions && (
        <div className="flex gap-[8px] pt-[2px]">
          {(showActions || onRevise) && (
            <Button variant="outline" size="sm" onClick={onRevise}>
              改める
            </Button>
          )}
          {(showActions || onApprove) && (
            <Button variant="gold" size="sm" onClick={onApprove}>
              認める
            </Button>
          )}
          {(showActions || onReject) && (
            <Button variant="ghost" size="sm" onClick={onReject}>
              退ける
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
