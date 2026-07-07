import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

export type ChipTone = "neutral" | "gold" | "success" | "danger" | "info";

type ToneStyle = { soft: string; solid: string };

const TONES: Record<ChipTone, ToneStyle> = {
  neutral: {
    soft: "border-[1.5px] border-sanba-frame bg-sanba-surface text-sanba-cream",
    solid: "border-[1.5px] border-transparent bg-sanba-select text-white",
  },
  gold: {
    soft: "border-[1.5px] border-sanba-gold-deep bg-transparent text-sanba-gold-text",
    solid: "sanba-gold-gradient border-[1.5px] border-sanba-frame text-sanba-ink",
  },
  success: {
    soft: "border-[1.5px] border-sanba-speak/40 bg-transparent text-sanba-speak-text",
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
  solid?: boolean;
  selected?: boolean;
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
        aria-pressed={asChild && selected !== undefined ? selected : undefined}
        className={cn(
          "inline-flex items-center justify-center rounded-full font-bold leading-none transition-colors",
          SIZES[size],
          emphasized ? TONES[tone].solid : TONES[tone].soft,
          className,
        )}
        {...props}
      >
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
