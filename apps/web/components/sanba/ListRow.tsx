import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

export interface ListRowProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  asChild?: boolean;
}

export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(
  ({ className, icon, title, subtitle, trailing, asChild, children, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref as never}
        className={cn(
          "flex w-full items-center gap-[12px] rounded-[16px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[14px] py-[12px] text-left transition-[box-shadow,transform] hover:shadow-[3px_3px_0_var(--sanba-shadow)]",
          className,
        )}
        {...props}
      >
        {icon != null && (
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[12px] border-[1.5px] border-sanba-frame bg-sanba-surface-strong text-[18px]">
            {icon}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-bold text-sanba-cream">{title}</span>
          {subtitle != null && (
            <span className="truncate text-[12px] text-sanba-muted">{subtitle}</span>
          )}
        </span>
        {trailing === undefined ? (
          <span className="shrink-0 text-[18px] text-sanba-muted" aria-hidden>
            ›
          </span>
        ) : (
          trailing
        )}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
ListRow.displayName = "ListRow";
