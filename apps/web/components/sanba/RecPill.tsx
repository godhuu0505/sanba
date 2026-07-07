import * as React from "react";

import { cn } from "@/lib/utils";

export interface RecPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  label?: React.ReactNode;
  children?: React.ReactNode;
}

export function RecPill({ className, label = "REC", children, ...props }: RecPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[6px] rounded-full border-[1.5px] border-sanba-rec bg-sanba-rec-pale px-[10px] py-[4px] text-[11px] font-bold text-sanba-rec-text",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="sanba-rec-dot size-[7px] shrink-0 rounded-full bg-sanba-rec" />
      <span className="whitespace-nowrap">
        {label}
        {children != null && <> {children}</>}
      </span>
    </span>
  );
}
