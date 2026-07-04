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
 * ドックの縁に座って耳を澄ますサンバさん（ADR-0033 §5）。純装飾（aria-hidden）。
 * Figure の semantic 5 状態は状態表示専用に保ち、ここは専用の小さな座り姿を持つ
 * （腿は前へ・脛を垂らし、片手を耳へ、萌黄の音波）。集音中だけ出す。
 * 音波の脈動は .sanba-fig-joint 経由で prefers-reduced-motion 時に静止する。
 */
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
        {/* 耳に手を当てる */}
        <path d="M19 22 L28 17 L27 11" />
        {/* 座った脚：腿を前へ、脛を下へ垂らす（縁に腰かける） */}
        <path d="M19 30 L31 31 L31 41" />
        <path d="M19 30 L30 34 L26 42" />
        {/* 胸の産章（山吹の丸） */}
        <circle cx="19" cy="23" r="3.2" fill="var(--sanba-gold)" strokeWidth={2} />
      </g>
      {/* 萌黄の音波（耳を澄ます） */}
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
      // relative は座るサンバさん（ドック上辺に腰かける装飾）の絶対配置の基準。
      className={cn(
        "relative flex w-full items-center justify-between gap-[12px] border-t-2 border-sanba-frame bg-sanba-surface px-[16px] pb-[12px] pt-[12px]",
        className,
      )}
      {...props}
    >
      {/* ドック右上の縁に座って耳を澄ますサンバさん（集音中のみ・純装飾）。 */}
      {!muted && (
        <span aria-hidden className="pointer-events-none absolute right-[14px] top-0 -translate-y-[86%]">
          <SeatedSanba />
        </span>
      )}
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
