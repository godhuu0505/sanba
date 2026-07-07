import * as React from "react";

import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Screen } from "./Screen";

export interface BrandSplashProps {
  label?: string;
  className?: string;
}

export function BrandSplash({ label = "読み込み中", className }: BrandSplashProps) {
  return (
    <Screen className={cn("items-center justify-center", className)}>
      <div role="status" aria-label={label} className="flex flex-col items-center gap-4">
        <BrandMark className="h-16 w-auto motion-safe:animate-pulse" aria-hidden />
        <span className="sanba-display text-[20px] font-bold tracking-wide text-sanba-cream">
          SANBA
        </span>
      </div>
    </Screen>
  );
}
