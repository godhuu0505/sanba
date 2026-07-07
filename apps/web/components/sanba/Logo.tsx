import * as React from "react";

import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";

const SIZES = {
  sm: { box: "h-[26px]", word: "text-[13px]" },
  md: { box: "h-[32px]", word: "text-[15px]" },
  lg: { box: "h-[44px]", word: "text-[20px]" },
} as const;

export interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: keyof typeof SIZES;
  wordmark?: boolean;
}

export function Logo({ className, size = "md", wordmark = true, ...props }: LogoProps) {
  const s = SIZES[size];
  return (
    <div className={cn("flex items-center gap-[9px]", className)} {...props}>
      <BrandMark
        className={cn("w-auto", s.box)}
        role="img"
        aria-label={wordmark ? undefined : "SANBA"}
        aria-hidden={wordmark ? true : undefined}
      />
      {wordmark && (
        <span className={cn("sanba-display font-bold text-sanba-cream", s.word)}>SANBA</span>
      )}
    </div>
  );
}
