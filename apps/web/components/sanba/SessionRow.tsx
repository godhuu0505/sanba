import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";
import { Chip } from "./Chip";

/**
 * 管理ホームのセッション一覧 1 行。標題＋メタ（招待者・日付）＋操作ピル。
 *
 * `asChild` でカード全体をリンク化できる。内容を複数の子として描画するため、
 * Slottable で host 要素（利用側の <a> 等）を 1 つのマージ対象として印付けし、他の子を
 * その中へ入れて Radix Slot の「単一子のみ」制約によるクラッシュを避ける。利用例:
 *   <SessionRow asChild title="…"><a href="/s/1" /></SessionRow>
 */
export interface SessionRowProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** 操作ピルの文言（既定: 検める ›）。null で非表示（閲覧専用の行）。 */
  action?: React.ReactNode | null;
  asChild?: boolean;
}

export const SessionRow = React.forwardRef<HTMLElement, SessionRowProps>(
  ({ className, title, meta, action = "検める ›", asChild, children, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref as never}
        className={cn(
          // 1.5px 墨枠＋角丸16 の札。ホバーで墨のオフセット影が生えて浮く（ADR-0033）。
          "flex w-full items-center gap-[12px] rounded-[16px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[14px] py-[13px] transition-[box-shadow,transform] hover:shadow-[3px_3px_0_var(--sanba-shadow)]",
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-[14px] font-bold text-sanba-cream">{title}</span>
          {meta != null && (
            <span className="truncate text-[12px] text-sanba-muted">{meta}</span>
          )}
        </span>
        {/* action=null は操作ピルを出さない: 押せない行に操作の見た目を残さない。 */}
        {action !== null && (
          <Chip tone="gold" className="shrink-0">
            {action}
          </Chip>
        )}
        {/* asChild 時の host 要素（利用側の <a> 等）。上記の子はこの中に入る。 */}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
SessionRow.displayName = "SessionRow";
