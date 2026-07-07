import * as React from "react";

import { cn } from "@/lib/utils";

export interface BottomSheetProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  tone?: "danger" | "neutral";
  actions?: React.ReactNode;
}

export function BottomSheet({
  className,
  title,
  tone = "danger",
  actions,
  children,
  ...props
}: BottomSheetProps) {
  const titleId = React.useId();
  return (
    <div
      role="dialog"
      aria-labelledby={title != null ? titleId : undefined}
      className={cn(
        "flex w-full flex-col gap-[12px] rounded-t-[18px] border-x-[1.5px] border-t-2 border-sanba-frame bg-sanba-surface px-[18px] pb-[20px] pt-[10px]",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="mx-auto h-[4px] w-[40px] shrink-0 rounded-full bg-sanba-border-strong"
      />
      {title != null && (
        <h2
          id={titleId}
          className={cn(
            "text-[15px] font-bold",
            tone === "danger" ? "text-sanba-rec-text" : "text-sanba-cream",
          )}
        >
          {title}
        </h2>
      )}
      {children && (
        <div className="text-[13px] leading-relaxed text-sanba-muted">{children}</div>
      )}
      {actions && <div className="flex flex-col gap-[8px]">{actions}</div>}
    </div>
  );
}
