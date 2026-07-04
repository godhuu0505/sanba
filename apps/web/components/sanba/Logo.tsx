import * as React from "react";

import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "size-[24px]", glyph: "text-[11px]", word: "text-[13px]" },
  md: { box: "size-[30px]", glyph: "text-[14px]", word: "text-[15px]" },
  lg: { box: "size-[40px]", glyph: "text-[19px]", word: "text-[20px]" },
} as const;

/** SANBA のロゴ。山吹の円章「産」（一字だけ明朝＝旧・金章の系譜）＋任意のワードマーク。 */
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
          "sanba-gold-gradient sanba-serif flex items-center justify-center rounded-full border-2 border-sanba-frame font-bold text-sanba-ink",
          s.box,
          s.glyph,
        )}
        aria-hidden
      >
        {glyph}
      </span>
      {wordmark && (
        <span className={cn("sanba-display font-bold text-sanba-cream", s.word)}>
          SANBA
        </span>
      )}
    </div>
  );
}
