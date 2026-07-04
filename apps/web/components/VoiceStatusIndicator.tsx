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

import { type LucideIcon, Mic, Pause, Volume2, VolumeX } from "lucide-react";

import { Figure, type FigureState } from "@/components/sanba";
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
  // recognizing（認識中）/deliberating（検討中）/idle/phase 未指定や micOn=false は「待機中」。
  // これらの細分表示（例: 認識中の partial 連動）は #248 のスコープ外（agentSpeaking で発話は拾える）。
  return "idle";
}

// アイコン＋ラベルで状態を表す（色は補助・ADR-0017）。pulse は発話/聞き取りの「生きている」感。
const PRESENTATION: Record<
  VoiceStatus,
  { icon: LucideIcon; label: string; tone: string; pulse: boolean }
> = {
  "agent-speaking": {
    icon: Volume2,
    label: "発話中／読み上げ中",
    tone: "border-[var(--sanba-gold)] text-[var(--sanba-gold-text)]",
    pulse: true,
  },
  listening: {
    icon: Mic,
    label: "聞き取り中",
    tone: "border-[var(--sanba-border-strong)] text-[var(--sanba-cream)]",
    pulse: true,
  },
  muted: {
    icon: VolumeX,
    label: "消音中",
    tone: "border-[var(--sanba-rec)] text-[var(--sanba-rec-text)]",
    pulse: false,
  },
  idle: {
    icon: Pause,
    label: "待機中",
    tone: "border-[var(--sanba-border)] text-[var(--sanba-muted)]",
    pulse: false,
  },
};

/**
 * 音声状態 → 棒人間サンバさんの状態（ADR-0033 §6 の配線）。
 * 聞き取り中だけ耳を澄ますサンバさんを添える。発話中/消音中/待機中はステータスピルの
 * 文言＋アイコンに委ね figure は出さない（1 画面 1 体・過剰演出の回避）。
 * 将来 agent-speaking→asking 等へ拡張する余地を残し、写像を 1 箇所に閉じ込める。
 */
export function figureStateForVoiceStatus(status: VoiceStatus): FigureState | null {
  return status === "listening" ? "listening" : null;
}

export function VoiceStatusIndicator(props: VoiceStatusIndicatorProps) {
  const status = resolveVoiceStatus(props);
  const { icon: Icon, label, tone, pulse } = PRESENTATION[status];
  const figState = figureStateForVoiceStatus(status);

  // role="status" を常に同一のルートノードに固定し live region を安定させる（a11y）。
  // 遷移で Figure の有無が変わっても role="status" ノード自体は差し替わらない。
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`音声状態: ${label}`}
      data-status={status}
      className="flex flex-col items-center gap-1"
    >
      {/* 聞き取り中だけサンバさんが耳を澄ます。意味はこの role=status/aria-live が読み上げるので装飾（aria-hidden）。 */}
      {figState && <Figure state={figState} className="w-[34px]" />}
      <div
        className={`flex items-center justify-center gap-1.5 rounded-full border bg-[var(--sanba-surface)] px-3 py-1 text-[11px] font-bold ${tone}`}
      >
        {/* 発話/聞き取り中は点滅ドットで「生きている」状態を示す（色のみに依存しない補助）。 */}
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`}
        />
        <Icon size={14} aria-hidden />
        <span>{label}</span>
      </div>
    </div>
  );
}
