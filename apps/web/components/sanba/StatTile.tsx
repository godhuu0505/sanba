import * as React from "react";

import { cn } from "@/lib/utils";

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  value: React.ReactNode;
  label: React.ReactNode;
}

export function StatTile({ className, value, label, ...props }: StatTileProps) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center gap-[2px] rounded-[16px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[8px] py-[12px] text-center",
        className,
      )}
      {...props}
    >
      <span className="text-[22px] font-bold leading-none text-sanba-gold-text">
        {value}
      </span>
      <span className="text-[11px] text-sanba-muted">{label}</span>
    </div>
  );
}
