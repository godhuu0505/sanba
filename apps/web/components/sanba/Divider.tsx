import * as React from "react";

import { cn } from "@/lib/utils";

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
}

export function Divider({ className, label, ...props }: DividerProps) {
  if (label != null) {
    return (
      <div className={cn("flex w-full items-center gap-[10px]", className)} {...props}>
        <span className="h-px flex-1 bg-sanba-border" />
        <span className="text-[12px] text-sanba-muted">{label}</span>
        <span className="h-px flex-1 bg-sanba-border" />
      </div>
    );
  }
  return <div className={cn("h-px w-full bg-sanba-border", className)} {...props} />;
}
