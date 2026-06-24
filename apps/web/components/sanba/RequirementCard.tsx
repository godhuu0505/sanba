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

/**
 * 「要件を検める」のレビュー札。状態チップ＋確度（役割）／要件文／メタ（優先度・分類）／
 * 操作（改める・認める・退ける）。操作は handler を渡すと既定の三択を描く。
 */
export interface RequirementCardProps extends React.HTMLAttributes<HTMLDivElement> {
  status: RequirementStatus;
  /** 例: "企画 ・ 確度 82%"。 */
  confidence?: React.ReactNode;
  /** 要件の本文。children と同義（どちらでも可）。 */
  statement?: React.ReactNode;
  /** 例: "優先度: should ・ 分類: scope"。 */
  meta?: React.ReactNode;
  onRevise?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  /** handler を渡さず操作行だけ描きたいとき（ショーケース等）に true。 */
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
        "flex w-full flex-col gap-[10px] rounded-[14px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[16px] py-[14px]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-[10px]">
        <Chip tone={s.tone} solid={status !== "draft"}>
          {s.label}
        </Chip>
        {confidence != null && (
          <span className="text-[12px] text-[var(--sanba-muted)]">{confidence}</span>
        )}
      </div>
      <p className="text-[14px] leading-[1.5] text-[var(--sanba-cream)]">{statement ?? children}</p>
      {meta != null && <p className="text-[12px] text-[var(--sanba-muted)]">{meta}</p>}
      {hasActions && (
        <div className="flex gap-[8px] pt-[2px]">
          <Button variant="outline" size="sm" onClick={onRevise}>
            改める
          </Button>
          <Button variant="gold" size="sm" onClick={onApprove}>
            認める
          </Button>
          <Button variant="ghost" size="sm" onClick={onReject}>
            退ける
          </Button>
        </div>
      )}
    </div>
  );
}
