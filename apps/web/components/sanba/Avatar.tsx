"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "agent" | "user";
  glyph: string;
  size?: number;
  imageUrl?: string;
  alt?: string;
}

export function Avatar({
  className,
  tone = "agent",
  glyph,
  size = 32,
  imageUrl,
  alt = "",
  ...props
}: AvatarProps) {
  const isAgent = tone === "agent";
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [imageUrl]);

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        {...(props as React.ImgHTMLAttributes<HTMLImageElement>)}
        src={imageUrl}
        alt={alt}
        referrerPolicy="no-referrer"
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={{ width: size, height: size }}
        className={cn(
          "shrink-0 rounded-full border-[1.5px] border-sanba-frame object-cover",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.47),
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-sanba-frame font-bold",
        isAgent
          ? "sanba-gold-gradient sanba-serif text-sanba-ink"
          : "bg-sanba-select-pale text-sanba-select",
        className,
      )}
      {...props}
    >
      {glyph}
    </span>
  );
}
