"use client";

import * as Popover from "@radix-ui/react-popover";
import { CircleHelp } from "lucide-react";

import { HELP, type HelpTerm } from "@/lib/help";

export interface HelpIconProps {
  term: HelpTerm;
  className?: string;
}

export function HelpIcon({ term, className }: HelpIconProps) {
  const entry = HELP[term];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${term}の説明`}
          className={`inline-flex items-center justify-center rounded-full text-sanba-muted transition-colors hover:text-sanba-gold-text focus-visible:text-sanba-gold-text ${className ?? ""}`}
        >
          <CircleHelp size={14} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-[260px] rounded-[12px] border border-sanba-border bg-sanba-surface px-3 py-[10px] text-left shadow-lg"
        >
          <p className="text-[12px] font-bold text-sanba-gold-text">{entry.title}</p>
          <p className="mt-[4px] text-[11.5px] leading-relaxed text-sanba-cream">{entry.body}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
