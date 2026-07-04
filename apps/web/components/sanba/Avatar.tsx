import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 円形アバター。SANBA（産婆）は山吹の産章、参加者は瑠璃の淡色面で描き分ける。
 * どちらも墨の縁取り（ADR-0025 の手描き線）。役割の一字（企/エ/客 など）を入れて話者を示す。
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
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--sanba-frame)] font-bold",
        isAgent
          ? "sanba-gold-gradient sanba-serif text-[var(--sanba-ink)]"
          : "bg-[var(--sanba-select-pale)] text-[var(--sanba-select)]",
        className,
      )}
      {...props}
    >
      {glyph}
    </span>
  );
}
