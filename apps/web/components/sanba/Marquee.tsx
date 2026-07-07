import * as React from "react";

import { cn } from "@/lib/utils";

export interface MarqueeProps extends React.HTMLAttributes<HTMLDivElement> {
  items: React.ReactNode[];
  durationSec?: number;
}

export function Marquee({ className, items, durationSec = 22, ...props }: MarqueeProps) {
  const sequence = (keyPrefix: string) =>
    items.map((item, i) => (
      <span key={`${keyPrefix}-${i}`} className="flex items-center gap-[14px] whitespace-nowrap">
        <span>{item}</span>
        <span aria-hidden className="text-sanba-border-strong">
          ✦
        </span>
      </span>
    ));
  return (
    <div
      aria-hidden
      className={cn(
        "sanba-marquee overflow-hidden border-y-2 border-sanba-frame bg-sanba-surface py-[8px]",
        className,
      )}
      {...props}
    >
      <div
        className="sanba-marquee-track flex w-max items-center gap-[14px] text-[13px] font-bold text-sanba-cream"
        style={{ animationDuration: `${durationSec}s` }}
      >
        {sequence("a")}
        {sequence("b")}
      </div>
    </div>
  );
}
