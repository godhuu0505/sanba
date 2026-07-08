"use client";

import { ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { HelpIcon } from "@/components/sanba";
import { detectionHelpTerm, detectionPresentation } from "@/lib/realtime/mapping";
import type { DetectionKind } from "@/lib/realtime/types";

const LONG_PRESS_MS = 450;

export interface ChoiceOption {
  label: string;
  sub?: string;
  fixed?: boolean;
}

export interface ChoiceStripProps {
  mode: "min" | "list";
  question: string;
  options: ChoiceOption[];
  onSelect: (index: number) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onOpenDetail: (index: number) => void;
  detectionKind?: DetectionKind;
}

export function ChoiceStrip({
  mode,
  question,
  options,
  onSelect,
  onExpand,
  onCollapse,
  onOpenDetail,
  detectionKind,
}: ChoiceStripProps) {
  const pressTimer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const startPress = (i: number) => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      onOpenDetail(i);
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => window.clearTimeout(pressTimer.current);
  useEffect(() => () => window.clearTimeout(pressTimer.current), []);
  const chipClick = (i: number) => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    onSelect(i);
  };

  if (options.length === 0) return null;

  const presentation = detectionKind ? detectionPresentation(detectionKind) : null;
  const accent = presentation ? presentation.color : "var(--sanba-gold-deep)";

  return (
    <div
      className="flex flex-col gap-2 border-t-2 bg-sanba-surface-strong px-4 py-[9px]"
      style={{ borderTopColor: accent }}
    >
      <div className="flex items-center gap-2">
        {presentation && (
          <span
            aria-label={presentation.ariaLabel}
            className="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
            style={{ backgroundColor: presentation.color }}
          >
            <presentation.Icon size={11} aria-hidden /> {presentation.label}
          </span>
        )}
        {detectionKind && <HelpIcon term={detectionHelpTerm(detectionKind)} />}
        <span className="text-[12px] font-bold text-sanba-gold-text">{question}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={mode === "min" ? onExpand : onCollapse}
          className="inline-flex items-center gap-1 rounded-full border border-sanba-frame bg-sanba-surface px-[9px] py-1 text-[10.5px] font-bold text-sanba-gold-text"
        >
          {mode === "min" ? (
            <>
              <Maximize2 size={11} aria-hidden /> 広げる
            </>
          ) : (
            <>
              <Minimize2 size={11} aria-hidden /> 閉じる
            </>
          )}
        </button>
      </div>

      {mode === "min" ? (
        <div className="flex gap-[6px] overflow-x-auto">
          {options.map((o, i) => {
            const longPress = o.fixed
              ? {}
              : {
                  onPointerDown: () => startPress(i),
                  onPointerUp: cancelPress,
                  onPointerLeave: cancelPress,
                  onPointerCancel: cancelPress,
                };
            return (
              <button
                key={i}
                type="button"
                onClick={() => chipClick(i)}
                {...longPress}
                className={`shrink-0 rounded-full border px-[11px] py-[6px] text-[12px] font-bold ${
                  o.fixed
                    ? "border-dashed border-sanba-border-strong text-sanba-muted"
                    : "border-sanba-frame bg-sanba-surface text-sanba-gold-text"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-[6px]">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onSelect(i)}
                className={`flex flex-1 flex-col items-start rounded-[10px] border px-[10px] py-[9px] text-left ${
                  o.fixed
                    ? "border-dashed border-sanba-border-strong bg-sanba-bg"
                    : "border-sanba-border bg-sanba-surface"
                }`}
              >
                <span className="text-[13px] font-bold text-sanba-cream">{o.label}</span>
                {o.sub && <span className="text-[10.5px] text-sanba-muted">{o.sub}</span>}
              </button>
              {!o.fixed && (
                <button
                  type="button"
                  onClick={() => onOpenDetail(i)}
                  className="inline-flex shrink-0 items-center gap-[2px] rounded-full border border-sanba-frame px-[9px] py-[5px] text-[10.5px] font-bold text-sanba-gold-text"
                >
                  詳細 <ChevronRight size={11} aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
