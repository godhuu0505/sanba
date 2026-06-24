import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * SANBA の操作ボタン。Figma の Button-Gold / Outline / Ghost を再現する。
 * shadcn の Button（components/ui）とは別系統で、dark + gold 文脈専用。
 */
export const sanbaButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] font-bold transition-[opacity,colors,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sanba-gold)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sanba-bg)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // 金箔グラデの主 CTA。テキストは濃色で箔に映える。
        gold: "sanba-gold-gradient text-[var(--sanba-ink)] hover:opacity-90",
        // 面＋金枠の副次ボタン。
        outline:
          "border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[var(--sanba-cream)] hover:border-[var(--sanba-frame)]",
        // テキストのみの第三ボタン。
        ghost: "text-[var(--sanba-muted)] hover:text-[var(--sanba-cream)]",
      },
      size: {
        sm: "px-3 py-2 text-[13px]",
        md: "px-4 py-[13px] text-[14px]",
        lg: "px-6 py-[15px] text-[15px]",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "gold", size: "md", block: false },
  },
);

export interface SanbaButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof sanbaButtonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, SanbaButtonProps>(
  ({ className, variant, size, block, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(sanbaButtonVariants({ variant, size, block, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "SanbaButton";
