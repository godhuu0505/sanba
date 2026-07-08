import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";
import { Chip } from "./Chip";

export interface SessionRowProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode | null;
  asChild?: boolean;
}

export const SessionRow = React.forwardRef<HTMLElement, SessionRowProps>(
  ({ className, title, meta, action = "確認する ›", asChild, children, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref as never}
        className={cn(
          "flex w-full items-center gap-[12px] rounded-[16px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[14px] py-[13px] transition-[box-shadow,transform] hover:shadow-[3px_3px_0_var(--sanba-shadow)]",
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-[14px] font-bold text-sanba-cream">{title}</span>
          {meta != null && (
            <span className="truncate text-[12px] text-sanba-muted">{meta}</span>
          )}
        </span>
        {action !== null && (
          <Chip tone="gold" className="shrink-0">
            {action}
          </Chip>
        )}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
SessionRow.displayName = "SessionRow";
