import * as React from "react";
import { Lightbulb } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ひらめきカード（ADR-0033 §7）。要件確定・気づきの瞬間に灯す山吹の付箋。
 * 山吹淡（--sanba-gold-pale）の面＋1.5px の破線＋電球アイコン＋手描きの揺らぎ角丸。
 *
 * AA: 破線・電球・見出しは山吹の暗色 --sanba-gold-text（#985c06）で統一。淡い山吹面 gold-pale
 * 上でも 4.9:1（文字 AA・図形 3:1 の双方を満たす）。ADR-0033 の破線 #C98F0D は gold-pale 上で
 * 2.8:1 と非文字 3:1 に届かないため、意図（黄土の破線）を汲みつつ AA 安全な暗色へ寄せた。
 * 本文は墨（--sanba-cream）で高コントラスト。棒人間サンバさんの insight と対で使う想定。
 */
export interface InsightCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** 小見出し（既定: ひらめき）。null で省略。 */
  title?: React.ReactNode;
}

export function InsightCard({ className, title = "ひらめき", children, ...props }: InsightCardProps) {
  return (
    <div
      className={cn(
        "sanba-wobble flex w-full gap-[10px] border-[1.5px] border-dashed border-sanba-gold-text bg-sanba-gold-pale px-[14px] py-[12px]",
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
