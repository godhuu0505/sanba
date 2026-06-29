import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

/**
 * アイコン＋2 行ラベル＋末尾シェブロンの汎用リスト行。
 * 「素材を渡す」の入力手段一覧などに使う。
 *
 * `asChild` で行全体を <button>/<a> 化できる（#162）。本コンポーネントは内容（icon/title/
 * trailing）を複数の子として描画するため、素朴に Slot へ渡すと Radix の「単一子のみ」制約に
 * 触れて実行時クラッシュする。Slottable で host 要素（利用側の <a>/<button>）を 1 つの
 * マージ対象として印付けし、他の子をその中へ入れることで解消する。利用例:
 *   <ListRow asChild title="…" icon={…}><a href="/x" /></ListRow>
 *   → <a href="/x" class="row…">{icon}{title}{trailing}</a>
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
  ({ className, icon, title, subtitle, trailing, asChild, children, ...props }, ref) => {
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
        {/* asChild 時の host 要素（利用側の <a>/<button>）。上記の子はこの中に入る。
            非 asChild（div）では children 未指定が通常で、Slottable は何も描かない。 */}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
ListRow.displayName = "ListRow";
