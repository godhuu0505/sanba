import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";
import { Chip } from "./Chip";

/**
 * 管理ホームのセッション一覧 1 行。標題＋メタ（招待者・日付）＋操作ピル。
 * `asChild` でカード全体をリンク化できる。
 */
export interface SessionRowProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** 操作ピルの文言（既定: 検める ›）。 */
  action?: React.ReactNode;
  asChild?: boolean;
}

export const SessionRow = React.forwardRef<HTMLElement, SessionRowProps>(
  ({ className, title, meta, action = "検める ›", asChild, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref as never}
        className={cn(
          "flex w-full items-center gap-[12px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[14px] py-[13px] transition-colors hover:border-[var(--sanba-frame)]",
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-[14px] font-bold text-[var(--sanba-cream)]">{title}</span>
          {meta != null && (
            <span className="truncate text-[12px] text-[var(--sanba-muted)]">{meta}</span>
          )}
        </span>
        <Chip tone="gold" className="shrink-0">
          {action}
        </Chip>
      </Comp>
    );
  },
);
SessionRow.displayName = "SessionRow";
