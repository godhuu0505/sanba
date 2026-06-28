"use client";

// 会話の音声状態を常時可視化するインジケータ（#248 / 監査 B-4 #20）。
// Figma 04 会話フェーズの「リスニング中／発話中／読み上げ中」状態表示に対応する。
// 状態源は 2 系統:
//   - realtime の status.phase（listening 等 / realtime-contract §3）= ユーザー発話の聞き取り。
//   - LiveKit リモート参加者（エージェント）の発話検知（agentSpeaking）= 発話／読み上げ。
//   - muted は音声出力 OFF（消音）。
// 優先順位: 消音中 ＞ エージェント発話中 ＞ 聞き取り中 ＞ 待機中。
// a11y: 色だけに依存せずラベル＋アイコンで表す（ADR-0017）。role=status / aria-live で
// 状態変化をスクリーンリーダーへ通知する。

import type { SessionPhase } from "@/lib/realtime/types";

export type VoiceStatus = "muted" | "agent-speaking" | "listening" | "idle";

export interface VoiceStatusIndicatorProps {
  /** 会話全体フェーズ（status.phase / realtime-contract §3）。 */
  phase?: SessionPhase;
  /** マイク入力 ON か（LiveKit local track）。 */
  micOn: boolean;
  /** 音声出力の消音中か。 */
  muted: boolean;
  /** エージェント（LiveKit リモート参加者）が発話／読み上げ中か。 */
  agentSpeaking?: boolean;
}

/**
 * 2 系統の状態源（status.phase / LiveKit isSpeaking / muted）を優先順位で 1 つに畳む。
 * 消音は音声出力 OFF を最優先で示し、聞き取りは listening かつマイク入力中のときだけ。
 */
export function resolveVoiceStatus({
  phase,
  micOn,
  muted,
  agentSpeaking,
}: Pick<
  VoiceStatusIndicatorProps,
  "phase" | "micOn" | "muted" | "agentSpeaking"
>): VoiceStatus {
  if (muted) return "muted";
  if (agentSpeaking) return "agent-speaking";
  if (phase === "listening" && micOn) return "listening";
  return "idle";
}

// アイコン＋ラベルで状態を表す（色は補助・ADR-0017）。pulse は発話/聞き取りの「生きている」感。
const PRESENTATION: Record<
  VoiceStatus,
  { icon: string; label: string; tone: string; pulse: boolean }
> = {
  "agent-speaking": {
    icon: "🔊",
    label: "発話中／読み上げ中",
    tone: "border-[var(--sanba-gold)] text-[var(--sanba-gold-text)]",
    pulse: true,
  },
  listening: {
    icon: "🎙",
    label: "聞き取り中",
    tone: "border-[var(--sanba-border-strong)] text-[var(--sanba-cream)]",
    pulse: true,
  },
  muted: {
    icon: "🔇",
    label: "消音中",
    tone: "border-[var(--sanba-rec)] text-[#e0857c]",
    pulse: false,
  },
  idle: {
    icon: "⏸",
    label: "待機中",
    tone: "border-[var(--sanba-border)] text-[var(--sanba-muted)]",
    pulse: false,
  },
};

export function VoiceStatusIndicator(props: VoiceStatusIndicatorProps) {
  const status = resolveVoiceStatus(props);
  const { icon, label, tone, pulse } = PRESENTATION[status];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`音声状態: ${label}`}
      data-status={status}
      className={`flex items-center justify-center gap-1.5 rounded-full border bg-[var(--sanba-surface)] px-3 py-1 text-[11px] font-bold ${tone}`}
    >
      {/* 発話/聞き取り中は点滅ドットで「生きている」状態を示す（色のみに依存しない補助）。 */}
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`}
      />
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
