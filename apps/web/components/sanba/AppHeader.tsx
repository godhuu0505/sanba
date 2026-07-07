import { ChevronLeft } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Logo } from "./Logo";

export interface AppHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  onBack?: () => void;
  back?: boolean;
  brand?: boolean;
  right?: React.ReactNode;
}

export function AppHeader({
  className,
  title,
  onBack,
  back,
  brand: _brand,
  right,
  ...props
}: AppHeaderProps) {
  const showBack = back || typeof onBack === "function";
  const hasTitle = title != null && title !== "";
  return (
    <header
      className={cn(
        "flex w-full items-center gap-2.5 border-b border-sanba-border-strong bg-sanba-surface-strong px-4 py-1.5",
        className,
      )}
      {...props}
    >
      {showBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="flex size-7.5 shrink-0 items-center justify-center rounded-[10px] border-[1.5px] border-sanba-frame bg-sanba-surface text-sanba-cream transition-[box-shadow,transform] hover:shadow-[2px_2px_0_var(--sanba-shadow)]"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
      )}
      <Logo size={hasTitle ? "sm" : "md"} className="shrink-0" />
      {hasTitle && (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-sanba-border-strong" />
          <h1 className="truncate text-[15px] font-bold text-sanba-cream">{title}</h1>
        </>
      )}
      {right != null && <div className="ml-auto flex items-center">{right}</div>}
    </header>
  );
}
