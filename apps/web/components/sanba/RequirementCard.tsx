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
        // 要件を検めるレビュー札。主要カードより軽い 1.5px 墨枠＋手描きの揺らぎ角丸＋
        // 3px の淡い墨影（積み重なっても重くならない札の質感 / ADR-0033）。
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
          {/* showActions はショーケース用で全ボタンを強制表示。通常は handler が渡された分だけ描く。 */}
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
