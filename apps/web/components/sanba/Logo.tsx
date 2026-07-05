import * as React from "react";

import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "h-[26px]", word: "text-[13px]" },
  md: { box: "h-[32px]", word: "text-[15px]" },
  lg: { box: "h-[44px]", word: "text-[20px]" },
} as const;

/**
 * SANBA のロゴ。棒人間「サンバさん」（胸に山吹の産章）のマーク＋任意のワードマーク。
 * マークは墨の線画＋山吹の産章で、アプリアイコン（`app/icon.svg`）と系譜を共有する。
 * 小サイズでも読めるよう、ヘッダー用は吹き出し・電球・タイルを省いた線画のみとする。
 */
export interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: keyof typeof SIZES;
  /** ワードマーク「SANBA」を併記するか。 */
  wordmark?: boolean;
}

export function Logo({ className, size = "md", wordmark = true, ...props }: LogoProps) {
  const s = SIZES[size];
  return (
    <div className={cn("flex items-center gap-[9px]", className)} {...props}>
      <svg
        viewBox="0 0 40 44"
        className={cn("w-auto", s.box)}
        role="img"
        aria-label={wordmark ? undefined : "SANBA"}
        aria-hidden={wordmark ? true : undefined}
        fill="none"
        stroke="var(--sanba-frame)"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="20" cy="10" r="5.4" fill="var(--sanba-surface)" />
        <line x1="20" y1="15.4" x2="20" y2="27" />
        <line x1="20" y1="21" x2="13" y2="27.5" />
        <line x1="20" y1="21" x2="27" y2="27.5" />
        <line x1="20" y1="27" x2="13.5" y2="40" />
        <line x1="20" y1="27" x2="26.5" y2="40" />
        <circle cx="20" cy="22.4" r="3" fill="var(--sanba-gold)" strokeWidth={1.6} />
      </svg>
      {wordmark && (
        <span className={cn("sanba-display font-bold text-sanba-cream", s.word)}>SANBA</span>
      )}
    </div>
  );
}
