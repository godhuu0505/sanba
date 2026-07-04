import * as React from "react";

import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";

/**
 * 問答の吹き出し。
 *  - `author="agent"`: 左寄せ・白い面＋墨枠・SANBA の産章（山吹）。
 *  - `author="user"`:  右寄せ・瑠璃の淡色面＋瑠璃枠・参加者章。
 * しっぽ（角の欠け）は話者側の上角だけ詰めて向きを示す。
 */
export interface ChatBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
  author: "agent" | "user";
  /** アバターに入れる一字（既定: 産 / 企）。 */
  glyph?: string;
  /** アバターを隠す（連続発話の 2 通目以降など）。 */
  hideAvatar?: boolean;
}

export function ChatBubble({
  className,
  author,
  glyph,
  hideAvatar,
  children,
  ...props
}: ChatBubbleProps) {
  const isAgent = author === "agent";
  const avatar = hideAvatar ? (
    <span className="size-[32px] shrink-0" aria-hidden />
  ) : (
    <Avatar tone={isAgent ? "agent" : "user"} glyph={glyph ?? (isAgent ? "産" : "企")} />
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
