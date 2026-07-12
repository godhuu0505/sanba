"use client";

import { useState } from "react";
import { Mic, MicOff, SendHorizontal, Volume2, VolumeX } from "lucide-react";

import type { MicMode, PttPressProps } from "@/lib/usePushToTalk";

export interface BottomBarProps {
  micOn: boolean;
  muted: boolean;
  onToggleMic: () => void;
  onToggleMute: () => void;
  onSend: (text: string) => void;
  micMode?: MicMode;
  onMicModeChange?: (mode: MicMode) => void;
  pttPressed?: boolean;
  pttPressProps?: PttPressProps;
}

export function BottomBar({
  micOn,
  muted,
  onToggleMic,
  onToggleMute,
  onSend,
  micMode = "handsfree",
  onMicModeChange,
  pttPressed = false,
  pttPressProps,
}: BottomBarProps) {
  const [text, setText] = useState("");

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <div
      role="group"
      aria-label="会話コントロール"
      className="flex flex-col gap-2 border-t-2 border-sanba-frame bg-sanba-surface px-4 pb-[14px] pt-[10px]"
    >
      {onMicModeChange && (
        <div
          role="group"
          aria-label="マイク操作モード"
          className="flex rounded-full border border-sanba-border bg-sanba-surface p-0.5 text-[11px] font-bold"
        >
          <button
            type="button"
            aria-pressed={micMode === "handsfree"}
            onClick={() => onMicModeChange("handsfree")}
            className={`flex-1 rounded-full py-1.5 ${
              micMode === "handsfree"
                ? "sanba-gold-gradient border border-sanba-frame text-sanba-ink"
                : "text-sanba-muted"
            }`}
          >
            ハンズフリー
          </button>
          <button
            type="button"
            aria-pressed={micMode === "ptt"}
            onClick={() => onMicModeChange("ptt")}
            className={`flex-1 rounded-full py-1.5 ${
              micMode === "ptt"
                ? "sanba-gold-gradient border border-sanba-frame text-sanba-ink"
                : "text-sanba-muted"
            }`}
          >
            押して話す
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          aria-label="スピーカー消音"
          aria-pressed={muted}
          onClick={onToggleMute}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border py-3 text-[13px] font-bold ${
            muted
              ? "border-sanba-rec bg-sanba-rec-pale text-sanba-rec-text"
              : "border-sanba-border bg-sanba-surface text-sanba-muted"
          }`}
        >
          {muted ? (
            <>
              <VolumeX size={15} aria-hidden /> スピーカー消音中
            </>
          ) : (
            <>
              <Volume2 size={15} aria-hidden /> スピーカー消音
            </>
          )}
        </button>
        {micMode === "handsfree" ? (
          <button
            type="button"
            aria-label="マイクをミュート"
            aria-pressed={!micOn}
            onClick={onToggleMic}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border py-3 text-[13px] font-bold ${
              micOn
                ? "sanba-gold-gradient border-2 border-sanba-frame text-sanba-ink"
                : "border-sanba-rec bg-sanba-rec-pale text-sanba-rec-text"
            }`}
          >
            {micOn ? (
              <>
                <Mic size={15} aria-hidden /> 集音中
              </>
            ) : (
              <>
                <MicOff size={15} aria-hidden /> ミュート中
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            aria-label="押しながら話す"
            aria-pressed={pttPressed}
            title="押している間だけ送話します（Space 長押しでも可）"
            {...pttPressProps}
            className={`flex flex-1 touch-none select-none items-center justify-center gap-1.5 rounded-[12px] border py-3 text-[13px] font-bold ${
              pttPressed
                ? "sanba-gold-gradient border-2 border-sanba-frame text-sanba-ink"
                : "border-sanba-border bg-sanba-surface text-sanba-muted"
            }`}
          >
            {pttPressed ? (
              <>
                <Mic size={15} aria-hidden /> 送話中
              </>
            ) : (
              <>
                <MicOff size={15} aria-hidden /> 押して話す
                <span className="hidden font-normal sm:inline">（Space）</span>
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          aria-label="テキストで入力"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) send();
          }}
          placeholder="テキストで入力…"
          className="flex-1 rounded-full border border-sanba-border bg-sanba-surface px-[14px] py-[11px] text-[12.5px] text-sanba-cream placeholder:text-sanba-muted"
        />
        <button
          type="button"
          aria-label="送信"
          onClick={send}
          className="sanba-gold-gradient flex items-center justify-center rounded-full border-2 border-sanba-frame px-4 py-[10px] font-bold text-sanba-ink"
        >
          <SendHorizontal size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
