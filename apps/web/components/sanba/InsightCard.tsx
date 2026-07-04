import * as React from "react";
import { Lightbulb } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ひらめきカード（ADR-0033 §7）。要件確定・気づきの瞬間に灯す山吹の付箋。
 * 山吹淡（--sanba-gold-pale）の面＋1.5px の破線＋電球アイコン＋手描きの揺らぎ角丸。
 *
 * AA: 破線・電球は山吹の暗色（gold-deep / gold-text＝3:1 以上）、本文は墨（--sanba-cream）で
 * 淡い山吹面に載せても高コントラスト。棒人間サンバさんの insight と対で使う想定。
 */
export interface InsightCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** 小見出し（既定: ひらめき）。null で省略。 */
  title?: React.ReactNode;
}

export function InsightCard({ className, title = "ひらめき", children, ...props }: InsightCardProps) {
  return (
    <div
      className={cn(
        "sanba-wobble flex w-full gap-[10px] border-[1.5px] border-dashed border-sanba-gold-deep bg-sanba-gold-pale px-[14px] py-[12px]",
        className,
      )}
      {...props}
    >
      <Lightbulb size={18} aria-hidden className="mt-[1px] shrink-0 text-sanba-gold-text" />
      <div className="flex min-w-0 flex-col gap-[3px]">
        {title != null && (
          <span className="sanba-display text-[13px] font-bold text-sanba-gold-text">{title}</span>
        )}
        <div className="text-[13px] leading-relaxed text-sanba-cream">{children}</div>
      </div>
    </div>
  );
}
