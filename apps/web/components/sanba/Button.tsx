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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] font-bold tracking-[0.04em] transition-[opacity,colors,border-color,transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sanba-gold focus-visible:ring-offset-2 focus-visible:ring-offset-sanba-bg disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // 朱ステッカーの主 CTA（ADR-0033 §4）。白文字を載せる面は AA 安全な朱 #C43A20
        // （--sanba-rec-text / 白文字 5.3:1）。display 800・2px 墨枠・3.5px の墨オフセット影。
        // 押下で影が潰れ、その分だけ右下へ沈む。
        gold: "sanba-display border-2 border-sanba-frame bg-sanba-rec-text text-white font-extrabold shadow-[3.5px_3.5px_0_var(--sanba-frame)] hover:opacity-95 active:translate-x-[3.5px] active:translate-y-[3.5px] active:shadow-none",
        // 白ステッカーの副次ボタン（ADR-0033 §4）。白面・墨文字・2px 墨枠・3px の淡い墨影。
        outline:
          "border-2 border-sanba-frame bg-sanba-surface text-sanba-cream shadow-[3px_3px_0_rgba(34,30,26,0.15)] hover:opacity-95 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none",
        // テキストのみの第三ボタン（退ける・ログアウト等）。
        ghost: "text-sanba-muted hover:text-sanba-cream",
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
