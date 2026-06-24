import * as React from "react";

import { cn } from "@/lib/utils";

/** 金がかった 1px の区切り線。任意でラベルを中央に挟める。 */
export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
}

export function Divider({ className, label, ...props }: DividerProps) {
  if (label != null) {
    return (
      <div className={cn("flex w-full items-center gap-[10px]", className)} {...props}>
        <span className="h-px flex-1 bg-[var(--sanba-border)]" />
        <span className="text-[12px] text-[var(--sanba-muted)]">{label}</span>
        <span className="h-px flex-1 bg-[var(--sanba-border)]" />
      </div>
    );
  }
  return <div className={cn("h-px w-full bg-[var(--sanba-border)]", className)} {...props} />;
}
