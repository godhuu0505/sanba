import * as React from "react";

import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";

export interface ChatBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
  author: "agent" | "user";
  glyph?: string;
  hideAvatar?: boolean;
  avatarImageUrl?: string;
}

export function ChatBubble({
  className,
  author,
  glyph,
  hideAvatar,
  avatarImageUrl,
  children,
  ...props
}: ChatBubbleProps) {
  const isAgent = author === "agent";
  const avatar = hideAvatar ? (
    <span className="size-[32px] shrink-0" aria-hidden />
  ) : (
    <Avatar
      tone={isAgent ? "agent" : "user"}
      glyph={glyph ?? (isAgent ? "産" : "企")}
      imageUrl={isAgent ? undefined : avatarImageUrl}
      alt={isAgent ? "" : "あなたのアイコン"}
    />
  );
  const bubble = (
    <div
      className={cn(
        "max-w-[78%] px-[13px] py-[11px] text-[13px] leading-[1.52]",
        isAgent
          ? "rounded-[14px] rounded-tl-[4px] border-[1.5px] border-sanba-frame bg-sanba-cream-bubble text-sanba-ink-bubble"
          : "rounded-[14px] rounded-tr-[4px] border-[1.5px] border-sanba-select bg-sanba-select-pale text-sanba-cream",
      )}
    >
      {children}
    </div>
  );
  return (
    <div
      aria-label={isAgent ? "SANBA" : "あなた"}
      className={cn(
        "flex w-full items-start gap-[8px]",
        isAgent ? "justify-start" : "flex-row-reverse",
        className,
      )}
      {...props}
    >
      {avatar}
      {bubble}
    </div>
  );
}
