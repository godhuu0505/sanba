import * as React from "react";

import { cn } from "@/lib/utils";

// Figma 正本の 9 本のバー高（px）。集音中は息づかいで上下する。
const DEFAULT_BARS = [18, 40, 64, 34, 56, 28, 48, 62, 36];

/**
 * 音声の波形ビジュアライザ。
 *  - `state="active"`: 墨と萌黄が交互のバー＋脈動アニメ（集音中）。
 *  - `state="muted"`:  鈍色の静止バー（ミュート中）。
 */
export interface WaveformProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: "active" | "muted";
  /** バー高（px）の配列。省略時は正本の 9 本。 */
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
                  // 墨のバー地、偶数番目（1-index）のバーだけ萌黄で息づく（ADR-0033 §7）。
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
