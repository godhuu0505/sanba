import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

/**
 * アイコン＋2 行ラベル＋末尾シェブロンの汎用リスト行。
 * 「素材を渡す」の入力手段一覧などに使う。`asChild` で <button>/<a> 化できる。
 */
export interface ListRowProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 末尾要素。既定はシェブロン（›）。null で消す。 */
  trailing?: React.ReactNode;
  asChild?: boolean;
}

export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(
  ({ className, icon, title, subtitle, trailing, asChild, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref as never}
        className={cn(
          "flex w-full items-center gap-[12px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[14px] py-[12px] text-left transition-colors hover:border-[var(--sanba-frame)]",
          className,
        )}
        {...props}
      >
        {icon != null && (
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--sanba-surface-strong)] text-[18px]">
            {icon}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-bold text-[var(--sanba-cream)]">{title}</span>
          {subtitle != null && (
            <span className="truncate text-[12px] text-[var(--sanba-muted)]">{subtitle}</span>
          )}
        </span>
        {trailing === undefined ? (
          <span className="shrink-0 text-[18px] text-[var(--sanba-muted)]" aria-hidden>
            ›
          </span>
        ) : (
          trailing
        )}
      </Comp>
    );
  },
);
ListRow.displayName = "ListRow";
