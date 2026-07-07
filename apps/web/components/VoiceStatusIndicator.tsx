"use client";

import { type LucideIcon, Mic, Pause, Volume2, VolumeX } from "lucide-react";

import { Figure, type FigureState } from "@/components/sanba";
import type { SessionPhase } from "@/lib/realtime/types";

export type VoiceStatus = "muted" | "agent-speaking" | "listening" | "idle";

export interface VoiceStatusIndicatorProps {
  phase?: SessionPhase;
  micOn: boolean;
  muted: boolean;
  agentSpeaking?: boolean;
  compact?: boolean;
}

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

const PRESENTATION: Record<
  VoiceStatus,
  { icon: LucideIcon; label: string; tone: string; pulse: boolean }
> = {
  "agent-speaking": {
    icon: Volume2,
    label: "発話中／読み上げ中",
    tone: "border-sanba-gold text-sanba-gold-text",
    pulse: true,
  },
  listening: {
    icon: Mic,
    label: "聞き取り中",
    tone: "border-sanba-border-strong text-sanba-cream",
    pulse: true,
  },
  muted: {
    icon: VolumeX,
    label: "消音中",
    tone: "border-sanba-rec text-sanba-rec-text",
    pulse: false,
  },
  idle: {
    icon: Pause,
    label: "待機中",
    tone: "border-sanba-border text-sanba-muted",
    pulse: false,
  },
};

export function figureStateForVoiceStatus(status: VoiceStatus): FigureState | null {
  return status === "listening" ? "listening" : null;
}

export function VoiceStatusIndicator(props: VoiceStatusIndicatorProps) {
  const status = resolveVoiceStatus(props);
  const { icon: Icon, label, tone, pulse } = PRESENTATION[status];
  const figState = props.compact ? null : figureStateForVoiceStatus(status);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`音声状態: ${label}`}
      data-status={status}
      className="flex flex-col items-center gap-1"
    >
      {figState && <Figure state={figState} className="w-[34px]" />}
      <div
        className={`flex items-center justify-center gap-1.5 rounded-full border bg-sanba-surface px-3 py-1 text-[11px] font-bold ${tone}`}
      >
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
