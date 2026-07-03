import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * SANBA の操作ボタン。ADR-0025 のステッカー様式（墨枠＋ベタ塗りオフセット影）。
 * shadcn の Button（components/ui）とは別系統で、SANBA 体験の文脈専用。
 * variant 名は旧 Figma 正本（Button-Gold / Outline / Ghost）から維持している。
 */
export const sanbaButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] font-bold transition-[opacity,colors,border-color,transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sanba-gold)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--sanba-bg)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // 朱ベタの主 CTA（ステッカー）。押下で影の分だけ沈む。
        gold: "sanba-sticker bg-[var(--sanba-rec)] text-white hover:opacity-95 active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--sanba-shadow)]",
        // 白面＋墨枠の副次ボタン（ステッカー）。
        outline:
          "sanba-sticker bg-[var(--sanba-surface)] text-[var(--sanba-cream)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--sanba-shadow)]",
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
