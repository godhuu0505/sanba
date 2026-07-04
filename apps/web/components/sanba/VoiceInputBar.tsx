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
      // 会話ドック：上辺 2px 墨・白地（ADR-0033 §7）。会話面の底に全幅で置く。
      className={cn(
        "flex w-full items-center justify-between gap-[12px] border-t-2 border-sanba-frame bg-sanba-surface px-[16px] pb-[12px] pt-[12px]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-[12px]">
        <Waveform state={muted ? "muted" : "active"} />
        <span
          className={cn(
            // ステータス文言は萌黄テキスト＝--sanba-speak-text（白地 AA / ADR-0033）。
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
          // マイク＝46px の山吹ステッカー（2px墨枠＋墨オフセット影）。押下で影が潰れて沈む。
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
