import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SANBA の面（カード）。フォーム・案内・結果などの主要コンテナ。
 * ADR-0033 の主要カード＝ステッカー様式：2px 墨枠＋5px の墨オフセット影＋手描きの
 * 揺らぎ角丸（.sanba-sticker-card + .sanba-wobble）。「紙に貼った札」の質感。
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "sanba-sticker-card sanba-wobble flex w-full flex-col gap-[14px] bg-sanba-surface px-[18px] pb-[18px] pt-[20px]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "sanba-display text-[18px] font-bold leading-snug text-sanba-cream",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-[13px] leading-relaxed text-sanba-muted", className)} {...props} />
  );
}
