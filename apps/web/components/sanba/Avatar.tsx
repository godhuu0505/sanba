import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 円形アバター。SANBA（産婆）は金箔、参加者は萌黄→青磁のグラデで描き分ける。
 * 役割の一字（企/エ/客 など）を入れて話者を示す。
 */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "agent" | "user";
  glyph: string;
  size?: number;
}

export function Avatar({ className, tone = "agent", glyph, size = 32, ...props }: AvatarProps) {
  const isAgent = tone === "agent";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.47),
        ...(isAgent
          ? undefined
          : { backgroundImage: "linear-gradient(120deg, var(--sanba-speak), #5c97b0)" }),
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        isAgent ? "sanba-gold-gradient text-[var(--sanba-ink)]" : "text-[#13240f]",
        className,
      )}
      {...props}
    >
      {glyph}
    </span>
  );
}
