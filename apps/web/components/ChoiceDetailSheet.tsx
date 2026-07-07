"use client";

import { ChevronLeft, ChevronRight, Mic, X } from "lucide-react";

export interface ChoiceOptionDetail {
  label: string;
  how?: string;
  effect?: string;
  caution?: string;
  source?: string;
}

export interface ChoiceDetailSheetProps {
  option: ChoiceOptionDetail;
  index: number;
  total: number;
  onSelect: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onCompare: () => void;
}

function Section({ label, color, value }: { label: string; color: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-[2px]">
      <span className="text-[11px] font-bold" style={{ color }}>
        {label}
      </span>
      <span className="text-[12.5px] text-sanba-muted">{value}</span>
    </div>
  );
}

export function ChoiceDetailSheet({
  option,
  index,
  total,
  onSelect,
  onPrev,
  onNext,
  onClose,
  onCompare,
}: ChoiceDetailSheetProps) {
  return (
    <div className="flex flex-col gap-3 rounded-t-[18px] border-t-2 border-sanba-frame bg-sanba-surface px-4 pb-[18px] pt-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold text-sanba-gold-text">選択肢の詳細</span>
        <span className="text-[11px] text-sanba-muted">
          {index + 1} / {total}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="flex size-[26px] items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-[12px] text-sanba-muted"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-[11px] rounded-[14px] border border-sanba-border bg-sanba-surface-strong p-[14px]">
        <span className="text-[16px] font-bold text-sanba-cream">{option.label}</span>
        <Section label="どう並ぶ？" color="var(--sanba-gold-text)" value={option.how} />
        <Section label="効き目" color="var(--sanba-speak-text)" value={option.effect} />
        <Section label="留意" color="var(--sanba-caution)" value={option.caution} />
        <Section label="関連・出所" color="var(--sanba-muted)" value={option.source} />
      </div>

      <button
        type="button"
        onClick={onSelect}
        className="sanba-sticker sanba-gold-gradient inline-flex items-center justify-center gap-1.5 rounded-[13px] py-[13px] text-center text-[14px] font-bold text-sanba-ink active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_var(--sanba-shadow)]"
      >
        <Mic size={16} aria-hidden /> 「{option.label}」を選ぶ
      </button>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrev}
          className="inline-flex flex-1 items-center justify-center gap-[2px] rounded-[11px] border border-sanba-border py-[11px] text-[12px] font-bold text-sanba-muted"
        >
          <ChevronLeft size={13} aria-hidden /> 前の選択肢
        </button>
        <button
          type="button"
          onClick={onCompare}
          className="rounded-[11px] border border-sanba-frame px-[12px] py-[11px] text-[12px] font-bold text-sanba-gold-text"
        >
          比較
        </button>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex flex-1 items-center justify-center gap-[2px] rounded-[11px] border border-sanba-border py-[11px] text-[12px] font-bold text-sanba-muted"
        >
          次の選択肢 <ChevronRight size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}
