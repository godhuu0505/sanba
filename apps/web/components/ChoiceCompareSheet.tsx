"use client";

import { Check, TriangleAlert, X } from "lucide-react";

import { HelpIcon } from "@/components/sanba";

export interface CompareRow {
  label: string;
  effect?: string;
  caution?: string;
}

export interface ChoiceCompareSheetProps {
  rows: CompareRow[];
  onSelect: (index: number) => void;
  onClose: () => void;
  onDetail?: (index: number) => void;
}

export function ChoiceCompareSheet({ rows, onSelect, onClose, onDetail }: ChoiceCompareSheetProps) {
  return (
    <div className="flex flex-col gap-[10px] rounded-t-[18px] border-t-2 border-sanba-frame bg-sanba-surface px-4 pb-[18px] pt-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold text-sanba-gold-text">選択肢を見比べる</span>
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
      <div className="flex gap-3 text-[11px] font-bold">
        <span className="inline-flex items-center gap-1 text-sanba-speak-text">
          <Check size={13} aria-hidden /> 効き目
        </span>
        <HelpIcon term="効き目" />
        <span className="inline-flex items-center gap-1 text-sanba-caution">
          <TriangleAlert size={13} aria-hidden /> 留意
        </span>
        <HelpIcon term="留意" />
      </div>

      {rows.map((r, i) => (
        <div
          key={i}
          className="flex flex-col gap-[9px] rounded-[12px] border border-sanba-border bg-sanba-surface-strong px-3 py-[11px]"
        >
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-bold text-sanba-cream">{r.label}</span>
            <span className="flex-1" />
            {onDetail && (
              <button
                type="button"
                onClick={() => onDetail(i)}
                className="rounded-full border border-sanba-frame px-[9px] py-[4px] text-[10.5px] font-bold text-sanba-gold-text"
              >
                詳細
              </button>
            )}
            <button
              type="button"
              onClick={() => onSelect(i)}
              className="sanba-gold-gradient rounded-full border border-sanba-frame px-3 py-[5px] text-[11px] font-bold text-sanba-ink"
            >
              選ぶ
            </button>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 rounded-[9px] bg-sanba-surface px-[9px] py-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sanba-speak-text">
                <Check size={12} aria-hidden /> 効き目
              </span>
              <p className="text-[11.5px] text-sanba-muted">{r.effect ?? "—"}</p>
            </div>
            <div className="flex-1 rounded-[9px] bg-sanba-surface px-[9px] py-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sanba-caution">
                <TriangleAlert size={12} aria-hidden /> 留意
              </span>
              <p className="text-[11.5px] text-sanba-muted">{r.caution ?? "—"}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
