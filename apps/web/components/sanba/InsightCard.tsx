import * as React from "react";
import { Lightbulb } from "lucide-react";

import { cn } from "@/lib/utils";

export interface InsightCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
}

export function InsightCard({ className, title = "気づき", children, ...props }: InsightCardProps) {
  return (
    <div
      className={cn(
        "sanba-wobble flex w-full gap-[10px] border-[1.5px] border-dashed border-sanba-gold-text bg-sanba-gold-pale px-[14px] py-[12px]",
        className,
      )}
      {...props}
    >
      <Lightbulb size={18} aria-hidden className="mt-[1px] shrink-0 text-sanba-gold-text" />
      <div className="flex min-w-0 flex-col gap-[3px]">
        {title != null && (
          <span className="sanba-display text-[13px] font-bold text-sanba-gold-text">{title}</span>
        )}
        <div className="text-[13px] leading-relaxed text-sanba-cream">{children}</div>
      </div>
    </div>
  );
}
