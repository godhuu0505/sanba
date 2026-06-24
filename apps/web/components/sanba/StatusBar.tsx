import * as React from "react";

import { cn } from "@/lib/utils";

/** iOS 風ステータスバー（時刻＋電波/電池）。画面最上部に固定の高さで置く。 */
export interface StatusBarProps extends React.HTMLAttributes<HTMLDivElement> {
  time?: string;
  signal?: string;
}

export function StatusBar({
  className,
  time = "9:41",
  signal = "5G  100%",
  ...props
}: StatusBarProps) {
  return (
    <div
      className={cn(
        "flex h-[44px] w-full shrink-0 items-center justify-between px-[26px] font-bold",
        className,
      )}
      {...props}
    >
      <span className="text-[13px] text-[var(--sanba-cream)]">{time}</span>
      <span className="whitespace-pre text-[12px] text-[var(--sanba-muted)]">{signal}</span>
    </div>
  );
}
