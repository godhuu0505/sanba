import * as React from "react";

import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "size-[24px]", glyph: "text-[11px]", word: "text-[13px]" },
  md: { box: "size-[30px]", glyph: "text-[14px]", word: "text-[15px]" },
  lg: { box: "size-[40px]", glyph: "text-[19px]", word: "text-[20px]" },
} as const;

/** SANBA のロゴ。金箔の円章「産」＋任意のワードマーク。 */
export interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: keyof typeof SIZES;
  /** ワードマーク「SANBA」を併記するか。 */
  wordmark?: boolean;
  /** 円章に入れる字（既定: 産）。 */
  glyph?: string;
}

export function Logo({ className, size = "md", wordmark = true, glyph = "産", ...props }: LogoProps) {
  const s = SIZES[size];
  return (
    <div className={cn("flex items-center gap-[10px]", className)} {...props}>
      <span
        className={cn(
          "sanba-gold-gradient flex items-center justify-center rounded-full font-bold text-[var(--sanba-ink)]",
          s.box,
          s.glyph,
        )}
        aria-hidden
      >
        {glyph}
      </span>
      {wordmark && (
        <span className={cn("font-bold text-[var(--sanba-cream)]", s.word)}>SANBA</span>
      )}
    </div>
  );
}
