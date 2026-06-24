import * as React from "react";

import { cn } from "@/lib/utils";

/** ネイティブ <select> をベースにした軽量セレクト。Radix を持ち込まず SSR/build を安定させる
 *  (ADR-0014 Phase 4 の方針)。shadcn の見た目に寄せたスタイルだけを当てる。 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-md border border-[var(--color-input)] bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = "Select";

export { Select };
