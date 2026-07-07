import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const sanbaButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] font-bold tracking-[0.04em] transition-[opacity,colors,border-color,transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sanba-gold focus-visible:ring-offset-2 focus-visible:ring-offset-sanba-bg disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        gold: "sanba-display border-2 border-sanba-frame bg-sanba-rec-text text-white font-extrabold shadow-[3.5px_3.5px_0_var(--sanba-frame)] hover:opacity-95 active:translate-x-[3.5px] active:translate-y-[3.5px] active:shadow-none",
        outline:
          "border-2 border-sanba-frame bg-sanba-surface text-sanba-cream shadow-[3px_3px_0_var(--sanba-shadow-strong)] hover:opacity-95 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none",
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
