import * as React from "react";

import { cn } from "@/lib/utils";

const DEFAULT_BARS = [18, 40, 64, 34, 56, 28, 48, 62, 36];

export interface WaveformProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: "active" | "muted";
  bars?: number[];
}

export function Waveform({ className, state = "active", bars = DEFAULT_BARS, ...props }: WaveformProps) {
  const active = state === "active";
  return (
    <div
      className={cn("flex items-center gap-[4px]", className)}
      role="img"
      aria-label={active ? "集音中" : "ミュート中"}
      {...props}
    >
      {bars.map((h, i) => (
        <span
          key={i}
          style={{ height: h, animationDelay: active ? `${(i % 5) * 0.12}s` : undefined }}
          className={cn(
            "w-[5px] shrink-0 rounded-[3px]",
            active
              ? cn(
                  "sanba-wave-bar",
                  i % 2 === 0 ? "bg-sanba-frame" : "bg-sanba-speak",
                )
              : "bg-sanba-border-strong",
          )}
        />
      ))}
    </div>
  );
}
