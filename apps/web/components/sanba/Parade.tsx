import * as React from "react";

import { cn } from "@/lib/utils";
import { Figure } from "./Figure";

/**
 * 歩く一団パレード（ADR-0033 §5）。画面下部を複数の棒人間がのんびり横断する装飾帯。
 * 各体は sanba-parade-move で左端→右端へ渡り、負の animation-delay で等間隔にずらす。
 * 横断（外側）と歩行アニメ（Figure 内側の関節）は別レイヤなので両立する。
 *
 * 純装飾（aria-hidden・pointer-events-none）。ADR §6「1 画面に同時に出すのは 1 体まで」は
 * “状態を伝える Figure” の規則であり、この装飾チェーンは別枠。ただし listening/insight など
 * 状態表示の Figure と同一画面で同時に出さない（意味の混線を避ける）。呼び出し側で出し分ける。
 * `prefers-reduced-motion: reduce` では横断が止まり、各体は等間隔で静止する。
 */
export interface ParadeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 横断する棒人間の数（既定 4）。 */
  count?: number;
  /** 1 体が渡り切る秒数（既定 18s）。 */
  durationSec?: number;
}

export function Parade({ className, count = 4, durationSec = 18, ...props }: ParadeProps) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none relative h-[92px] w-full overflow-hidden", className)}
      {...props}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="sanba-parade-walker absolute bottom-0"
          style={{
            // 実行時は負 delay で路上に等間隔で撒く。静止時（reduced-motion）は inline left が効いて重ならない。
            left: `${(i / count) * 100}%`,
            animationDuration: `${durationSec}s`,
            animationDelay: `${-(durationSec / count) * i}s`,
          }}
        >
          <Figure state="walking" className="w-[30px]" />
        </div>
      ))}
    </div>
  );
}
