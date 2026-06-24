import * as React from "react";

import { cn } from "@/lib/utils";

/** SANBA の面（カード）。フォーム・案内・結果などの主要コンテナ。 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-[14px] rounded-[14px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[18px] pb-[18px] pt-[20px]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-[18px] font-bold leading-snug text-[var(--sanba-cream)]", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-[13px] leading-relaxed text-[var(--sanba-muted)]", className)} {...props} />
  );
}
