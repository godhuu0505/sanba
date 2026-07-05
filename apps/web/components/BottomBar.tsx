"use client";

// 常時2行ボトムバー。仕様: docs/design/conversation-experience.md §5。
// 1行目: 消音（音声出力 ON/OFF）/ マイク・ミュート（マイク入力 ON/OFF）の2系統トグル。
// 2行目: テキスト入力欄 + 送信（音声と併用）。
// a11y: 見た目が古語でも aria-label は現代語の機能名（ADR-0017）。

import { useState } from "react";
import { Mic, MicOff, Volume2, VolumeX } from "lucide-react";

import type { SessionPhase } from "@/lib/realtime/types";
import { VoiceStatusIndicator } from "./VoiceStatusIndicator";

export interface BottomBarProps {
  /** 会話＝マイク入力 ON か。 */
  micOn: boolean;
  /** 消音＝音声出力 OFF か。 */
  muted: boolean;
  onToggleMic: () => void;
  onToggleMute: () => void;
  /** テキスト送信（本文）。 */
  onSend: (text: string) => void;
  /** 会話全体フェーズ（音声状態インジケータ用 / #248）。 */
  phase?: SessionPhase;
  /** エージェント（LiveKit リモート参加者）が発話／読み上げ中か（#248）。 */
  agentSpeaking?: boolean;
}

export function BottomBar({
  micOn,
  muted,
  onToggleMic,
  onToggleMute,
  onSend,
  phase,
  agentSpeaking,
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
      {/* 音声状態の常時インジケータ（#248）。聞き取り中／発話中／読み上げ中／消音中を可視化。 */}
      <div className="flex justify-center">
        <VoiceStatusIndicator
          phase={phase}
          micOn={micOn}
          muted={muted}
          agentSpeaking={agentSpeaking}
        />
      </div>

      {/* 1行目: 消音（音声出力）/ マイク・ミュート（マイク入力） */}
      <div className="flex gap-2">
        <button
          type="button"
          aria-label="消音"
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
              <VolumeX size={15} aria-hidden /> 消音中
            </>
          ) : (
            <>
              <Volume2 size={15} aria-hidden /> 消音
            </>
          )}
        </button>
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
              <Mic size={15} aria-hidden /> マイク オン
            </>
          ) : (
            <>
              <MicOff size={15} aria-hidden /> ミュート中
            </>
          )}
        </button>
      </div>

      {/* 2行目: テキスト入力 / 送信 */}
      <div className="flex items-center gap-2">
        <input
          aria-label="テキストで入力"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 日本語IMEの変換確定 Enter で誤送信しない（isComposing / keyCode 229 を除外）。
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) send();
          }}
          placeholder="テキストで入力…"
          className="flex-1 rounded-full border border-sanba-border bg-sanba-surface px-[14px] py-[11px] text-[12.5px] text-sanba-cream placeholder:text-sanba-muted"
        />
        <button
          type="button"
          aria-label="送信"
          onClick={send}
          className="sanba-gold-gradient rounded-full border-2 border-sanba-frame px-4 py-[10px] text-[14px] font-bold text-sanba-ink"
        >
          ▶
        </button>
      </div>
    </div>
  );
}
