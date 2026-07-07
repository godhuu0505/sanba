import * as React from "react";

import { cn } from "@/lib/utils";

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
        "flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-sanba-frame font-bold",
        isAgent
          ? "sanba-gold-gradient sanba-serif text-sanba-ink"
          : "bg-sanba-select-pale text-sanba-select",
        className,
      )}
      {...props}
    >
      {glyph}
    </span>
  );
}
