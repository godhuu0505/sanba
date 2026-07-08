import * as React from "react";

import { cn } from "@/lib/utils";
import { Waveform } from "./Waveform";

function MicIcon({ muted }: { muted?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {muted && (
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

function SeatedSanba() {
  return (
    <svg viewBox="0 0 48 44" className="w-[30px]" aria-hidden>
      <g
        stroke="var(--sanba-frame)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <circle cx="20" cy="11" r="6.5" fill="var(--sanba-surface)" />
        <line x1="20" y1="17.5" x2="19" y2="30" />
        <path d="M19 22 L28 17 L27 11" />
        <path d="M19 30 L31 31 L31 41" />
        <path d="M19 30 L30 34 L26 42" />
        <circle cx="19" cy="23" r="3.2" fill="var(--sanba-gold)" strokeWidth={2} />
      </g>
      <g stroke="var(--sanba-speak)" strokeWidth={2} fill="none">
        <path
          className="sanba-fig-joint"
          style={{ animation: "sanba-fig-pulse 1.2s ease-in-out infinite" }}
          d="M33 15 q 4 5 0 10"
        />
        <path
          className="sanba-fig-joint"
          style={{ animation: "sanba-fig-pulse 1.2s ease-in-out 0.25s infinite" }}
          d="M38 12 q 7 8 0 16"
        />
      </g>
    </svg>
  );
}

export interface VoiceInputBarProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: "listening" | "muted";
  status?: React.ReactNode;
  onToggle?: () => void;
}

export function VoiceInputBar({
  className,
  state = "listening",
  status,
  onToggle,
  ...props
}: VoiceInputBarProps) {
  const muted = state === "muted";
  const label = status ?? (muted ? "● ミュート中" : "● 聞き取り中");
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-between gap-[12px] border-t-2 border-sanba-frame bg-sanba-surface px-[16px] pb-[12px] pt-[12px]",
        className,
      )}
      {...props}
    >
      {!muted && (
        <span aria-hidden className="pointer-events-none absolute right-[14px] top-0 -translate-y-[86%]">
          <SeatedSanba />
        </span>
      )}
      <div className="flex items-center gap-[12px]">
        <Waveform state={muted ? "muted" : "active"} />
        <span
          className={cn(
            "whitespace-nowrap text-[12.5px] font-bold",
            muted ? "text-sanba-muted" : "text-sanba-speak-text",
          )}
        >
          {label}
        </span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={muted}
        aria-label="マイクのミュート切替"
        className={cn(
          "flex size-[46px] shrink-0 items-center justify-center rounded-full transition-[opacity,transform,box-shadow]",
          muted
            ? "border-2 border-sanba-border-strong bg-sanba-surface text-sanba-muted"
            : "sanba-sticker sanba-gold-gradient text-sanba-ink hover:opacity-95 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
        )}
      >
        <MicIcon muted={muted} />
      </button>
    </div>
  );
}
