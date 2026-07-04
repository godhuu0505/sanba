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

const TONES: Record<ChipTone, ToneStyle> = {
  neutral: {
    soft: "border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[var(--sanba-muted)]",
    // 選択＝瑠璃（ADR-0025）。役割チップなど単一選択の「選ばれている」状態。
    solid: "border border-transparent bg-[var(--sanba-select)] text-white",
  },
  gold: {
    soft: "border border-[var(--sanba-gold-deep)] bg-transparent text-[var(--sanba-gold-text)]",
    solid: "sanba-gold-gradient border border-[var(--sanba-frame)] text-[var(--sanba-ink)]",
  },
  success: {
    soft: "border border-[var(--sanba-speak)]/40 bg-transparent text-[var(--sanba-speak-text)]",
    // 萌黄(#7fa83c)は明色で白文字だと 2.8:1（AA不可）。墨文字を載せる（5.9:1）。
    solid: "border border-transparent bg-[var(--sanba-speak)] text-[var(--sanba-ink)]",
  },
  danger: {
    soft: "border border-[var(--sanba-rec)]/40 bg-transparent text-[var(--sanba-rec-text)]",
    solid: "border border-transparent bg-[var(--sanba-rec-text)] text-white",
  },
  info: {
    soft: "border border-[var(--sanba-border)] bg-transparent text-[var(--sanba-cream)]",
    solid: "border border-transparent bg-[var(--sanba-surface-strong)] text-[var(--sanba-cream)]",
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
