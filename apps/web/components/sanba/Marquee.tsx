import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * マーキー帯（ADR-0033 §5）。上下 2px 墨・白地の帯を、キーメッセージが右→左へ流れる。
 * no.meets 由来の「軽やかに流れる帯」。継ぎ目を消すため items を 2 連結し -50% までループする。
 *
 * 純装飾なので全体は aria-hidden（読み上げ対象にしない）。要語に原色を差すときは items 側で
 * -text トークンを使う（朱=text-sanba-rec-text / 瑠璃=text-sanba-select / 山吹=text-sanba-gold-text。
 * --sanba-gold は小地文で AA 不足のため文字には使わない）。
 * `prefers-reduced-motion: reduce` では流れが止まる（globals: .sanba-marquee-track）。
 */
export interface MarqueeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 流すメッセージ群。各要素の間に区切り記号を挟んで並べる。 */
  items: React.ReactNode[];
  /** 一周の秒数（既定 22s）。 */
  durationSec?: number;
}

export function Marquee({ className, items, durationSec = 22, ...props }: MarqueeProps) {
  // 継ぎ目のない無限ループのため、同じ並びを 2 度描いて track を w-max（内容幅）にする。
  const sequence = (keyPrefix: string) =>
    items.map((item, i) => (
      <span key={`${keyPrefix}-${i}`} className="flex items-center gap-[14px] whitespace-nowrap">
        <span>{item}</span>
        <span aria-hidden className="text-sanba-border-strong">
          ✦
        </span>
      </span>
    ));
  return (
    <div
      aria-hidden
      className={cn(
        "sanba-marquee overflow-hidden border-y-2 border-sanba-frame bg-sanba-surface py-[8px]",
        className,
      )}
      {...props}
    >
      <div
        className="sanba-marquee-track flex w-max items-center gap-[14px] text-[13px] font-bold text-sanba-cream"
        style={{ animationDuration: `${durationSec}s` }}
      >
        {sequence("a")}
        {sequence("b")}
      </div>
    </div>
  );
}
