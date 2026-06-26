"use client";

// 選択肢の詳細確認（ボトムシート）。1選択肢を観点ごとに深掘りし、前後で巡回・比較・確定できる。
// 仕様: docs/design/conversation-experience.md §4。
// 観点データ（どう動く/効き目/留意/出所）は contract に無いため任意。与えられたものだけ描く。

export interface ChoiceOptionDetail {
  label: string;
  /** どう動く？ */
  how?: string;
  /** 効き目（萌黄）。 */
  effect?: string;
  /** 留意（黄土）。 */
  caution?: string;
  /** 関連・出所。 */
  source?: string;
}

export interface ChoiceDetailSheetProps {
  option: ChoiceOptionDetail;
  /** 何番目か（0 始まり・表示用）。 */
  index: number;
  /** 全選択肢数（表示用）。 */
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
      <span className="text-[12.5px] text-[var(--sanba-muted)]">{value}</span>
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
    <div className="flex flex-col gap-3 rounded-t-[18px] border-t border-[var(--sanba-frame)] bg-[#221910] px-4 pb-[18px] pt-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold text-[var(--sanba-gold-text)]">選択肢の詳細</span>
        <span className="text-[11px] text-[var(--sanba-muted)]">
          {index + 1} / {total}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="flex size-[26px] items-center justify-center rounded-full border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[12px] text-[var(--sanba-muted)]"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-[11px] rounded-[14px] border border-[var(--sanba-border)] bg-[#1b140b] p-[14px]">
        <span className="text-[16px] font-bold text-[var(--sanba-cream)]">{option.label}</span>
        <Section label="どう動く？" color="#d4af37" value={option.how} />
        <Section label="効き目" color="#a9be6e" value={option.effect} />
        <Section label="留意" color="#e0a93b" value={option.caution} />
        <Section label="関連・出所" color="#9a875e" value={option.source} />
      </div>

      <button
        type="button"
        onClick={onSelect}
        className="sanba-gold-gradient rounded-[13px] py-[14px] text-center text-[14px] font-bold text-[var(--sanba-ink)]"
      >
        🎙 「{option.label}」を選ぶ
      </button>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrev}
          className="flex-1 rounded-[11px] border border-[var(--sanba-border)] py-[11px] text-[12px] font-bold text-[var(--sanba-muted)]"
        >
          ‹ 前の選択肢
        </button>
        <button
          type="button"
          onClick={onCompare}
          className="rounded-[11px] border border-[var(--sanba-frame)] px-[12px] py-[11px] text-[12px] font-bold text-[var(--sanba-gold-text)]"
        >
          比較
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex-1 rounded-[11px] border border-[var(--sanba-border)] py-[11px] text-[12px] font-bold text-[var(--sanba-muted)]"
        >
          次の選択肢 ›
        </button>
      </div>
    </div>
  );
}
