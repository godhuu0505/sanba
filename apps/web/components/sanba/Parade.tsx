import * as React from "react";

import { cn } from "@/lib/utils";
import { Figure } from "./Figure";

export interface ParadeProps extends React.HTMLAttributes<HTMLDivElement> {
  count?: number;
  durationSec?: number;
}

export function Parade({ className, count = 4, durationSec = 18, ...props }: ParadeProps) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none relative h-[92px] w-full overflow-hidden", className)}
      {...props}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="sanba-parade-walker absolute bottom-0"
          style={{
            left: `${(i / count) * 100}%`,
            animationDuration: `${durationSec}s`,
            animationDelay: `${-(durationSec / count) * i}s`,
          }}
        >
          <Figure state="walking" className="w-[30px]" />
        </div>
      ))}
    </div>
  );
}
