import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * REC ピル（ADR-0033 §7）。録音中を静かに知らせる朱の丸薬。
 * 1.5px 朱枠（--sanba-rec）＋朱文字（--sanba-rec-text）＋淡い朱地、先頭に glowPulse で
 * 発光する朱のドット。文字は朱面ではなく淡地の上なので AA（rec-text は白/淡地で 4.5:1 以上）。
 *
 * ドットの脈動は `prefers-reduced-motion: reduce` で静止する（globals: .sanba-rec-dot）。
 */
export interface RecPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 先頭ラベル（既定: REC）。 */
  label?: React.ReactNode;
  /** 経過時間などの付随表示（例: "12:46"）。 */
  children?: React.ReactNode;
}

export function RecPill({ className, label = "REC", children, ...props }: RecPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[6px] rounded-full border-[1.5px] border-sanba-rec bg-sanba-rec-pale px-[10px] py-[4px] text-[11px] font-bold text-sanba-rec-text",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="sanba-rec-dot size-[7px] shrink-0 rounded-full bg-sanba-rec" />
      <span className="whitespace-nowrap">
        {label}
        {children != null && <> {children}</>}
      </span>
    </span>
  );
}
