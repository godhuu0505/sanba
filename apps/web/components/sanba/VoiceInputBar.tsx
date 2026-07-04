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

/**
 * 会話画面の音声入力ドック。波形＋状態テキスト＋マイクボタンを 1 つにまとめる。
 *  - `state="listening"`: 墨×萌黄の波形＋萌黄の「認識中」＋山吹マイク（ステッカー）。
 *  - `state="muted"`:     鈍色の波形＋「ミュート中」＋面のマイク（off）。
 * `onToggle` でマイクの ON/OFF を親に通知する。
 */
export interface VoiceInputBarProps extends React.HTMLAttributes<HTMLDivElement> {
  state?: "listening" | "muted";
  /** 状態テキストの差し替え（既定は state に応じた文言）。 */
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
  const label = status ?? (muted ? "● ミュート中" : "● 認識中...（あなたが発話中）");
  return (
    <div
      className={cn("flex w-full items-center justify-between gap-[12px] pt-[4px]", className)}
      {...props}
    >
      <div className="flex items-center gap-[12px]">
        <Waveform state={muted ? "muted" : "active"} />
        <span
          className={cn(
            "whitespace-nowrap text-[12.5px] font-bold",
            muted ? "text-[var(--sanba-muted)]" : "text-[var(--sanba-speak-text)]",
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
          "flex size-[56px] shrink-0 items-center justify-center rounded-full transition-[opacity,transform,box-shadow]",
          muted
            ? "border-2 border-[var(--sanba-border-strong)] bg-[var(--sanba-surface)] text-[var(--sanba-muted)]"
            : "sanba-sticker sanba-gold-gradient text-[var(--sanba-ink)] hover:opacity-95 active:translate-x-[1px] active:translate-y-[1px] active:shadow-[1px_1px_0_var(--sanba-shadow)]",
        )}
      >
        <MicIcon muted={muted} />
      </button>
    </div>
  );
}
