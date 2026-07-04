import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

/**
 * 丸薬型の小片。役割の選択肢・状態タグ・抽出キーワード・操作ピル（検める ›）など
 * SANBA 全体で多用する最小単位。トーン × 強調（soft/solid）で見た目を切り替える。
 *
 * - `selected` は役割チップのような単一選択 UI 向けの糖衣（= solid 強調）。
 * - `asChild` で <button>/<a> 等に化けさせ、操作ピルとして使える。
 */
export type ChipTone = "neutral" | "gold" | "success" | "danger" | "info";

type ToneStyle = { soft: string; solid: string };

// 役割チップは 1.5px 墨枠・角丸99（ADR-0033 §7）。soft/solid で枠幅を揃え、選択でサイズが跳ねない。
const TONES: Record<ChipTone, ToneStyle> = {
  neutral: {
    soft: "border-[1.5px] border-sanba-frame bg-sanba-surface text-sanba-cream",
    // 選択＝瑠璃ベタ＋白文字（ADR-0033）。役割チップなど単一選択の「選ばれている」状態。
    solid: "border-[1.5px] border-transparent bg-sanba-select text-white",
  },
  gold: {
    soft: "border-[1.5px] border-sanba-gold-deep bg-transparent text-sanba-gold-text",
    solid: "sanba-gold-gradient border-[1.5px] border-sanba-frame text-sanba-ink",
  },
  success: {
    soft: "border-[1.5px] border-sanba-speak/40 bg-transparent text-sanba-speak-text",
    // 萌黄(#7fa83c)は明色で白文字だと不足。墨文字を載せる（ADR-0033）。
    solid: "border-[1.5px] border-transparent bg-sanba-speak text-sanba-ink",
  },
  danger: {
    soft: "border-[1.5px] border-sanba-rec/40 bg-transparent text-sanba-rec-text",
    solid: "border-[1.5px] border-transparent bg-sanba-rec-text text-white",
  },
  info: {
    soft: "border-[1.5px] border-sanba-border bg-transparent text-sanba-cream",
    solid: "border-[1.5px] border-transparent bg-sanba-surface-strong text-sanba-cream",
  },
};

const SIZES = {
  sm: "px-[9px] py-[3px] text-[10px] gap-[4px]",
  md: "px-[12px] py-[5px] text-[12px] gap-[5px]",
} as const;

export interface ChipProps extends React.HTMLAttributes<HTMLElement> {
  tone?: ChipTone;
  size?: keyof typeof SIZES;
  /** 強調表示（塗り）にする。`selected` でも同じ効果。 */
  solid?: boolean;
  /** 役割の単一選択などで「選ばれている」状態。 */
  selected?: boolean;
  /** 先頭に状態ドット（●）を出す。 */
  dot?: boolean;
  asChild?: boolean;
}

export const Chip = React.forwardRef<HTMLElement, ChipProps>(
  (
    { className, tone = "neutral", size = "sm", solid, selected, dot, asChild, children, ...props },
    ref,
  ) => {
    const Comp: React.ElementType = asChild ? Slot : "span";
    const emphasized = solid || selected;
    return (
      <Comp
        ref={ref as never}
        data-selected={selected ? "" : undefined}
        // asChild かつ selected が明示されたとき aria-pressed でトグル状態をスクリーンリーダーへ通知する。
        // asChild=false の span は非インタラクティブなので aria-pressed は付けない。
        aria-pressed={asChild && selected !== undefined ? selected : undefined}
        className={cn(
          "inline-flex items-center justify-center rounded-full font-bold leading-none transition-colors",
          SIZES[size],
          emphasized ? TONES[tone].solid : TONES[tone].soft,
          className,
        )}
        {...props}
      >
        {/* asChild=true のとき Slot は単一子しか受け取れない。dot を出さないだけでなく、
            false 兄弟も Slot に渡さないよう children をそのまま 1 つだけ渡す。 */}
        {asChild ? (
          children
        ) : (
          <>
            {dot && <span aria-hidden>●</span>}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Chip.displayName = "Chip";
