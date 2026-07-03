"use client";

// 選択肢の比較（ボトムシート）。全選択肢を効き目（萌黄）/留意（黄土）で横並びに見比べ、各行で選べる。
// 仕様: docs/design/conversation-experience.md §4。

export interface CompareRow {
  label: string;
  effect?: string;
  caution?: string;
}

export interface ChoiceCompareSheetProps {
  rows: CompareRow[];
  onSelect: (index: number) => void;
  onClose: () => void;
  /** 各行から詳細へ深掘りする（任意）。 */
  onDetail?: (index: number) => void;
}

export function ChoiceCompareSheet({ rows, onSelect, onClose, onDetail }: ChoiceCompareSheetProps) {
  return (
    <div className="flex flex-col gap-[10px] rounded-t-[18px] border-t-2 border-[var(--sanba-frame)] bg-[var(--sanba-surface)] px-4 pb-[18px] pt-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold text-[var(--sanba-gold-text)]">選択肢を見比べる</span>
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
      <div className="flex gap-3 text-[11px] font-bold">
        <span className="text-[var(--sanba-speak)]">✓ 効き目</span>
        <span className="text-[#9c6b0e]">⚠ 留意</span>
      </div>

      {rows.map((r, i) => (
        <div
          key={i}
          className="flex flex-col gap-[9px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface-strong)] px-3 py-[11px]"
        >
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-bold text-[var(--sanba-cream)]">{r.label}</span>
            <span className="flex-1" />
            {onDetail && (
              <button
                type="button"
                onClick={() => onDetail(i)}
                className="rounded-full border border-[var(--sanba-frame)] px-[9px] py-[4px] text-[10.5px] font-bold text-[var(--sanba-gold-text)]"
              >
                詳細
              </button>
            )}
            <button
              type="button"
              onClick={() => onSelect(i)}
              className="sanba-gold-gradient rounded-full px-3 py-[5px] text-[11px] font-bold text-[var(--sanba-ink)]"
            >
              選ぶ
            </button>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 rounded-[9px] bg-[var(--sanba-surface)] px-[9px] py-2">
              <span className="text-[10px] font-bold text-[var(--sanba-speak)]">✓ 効き目</span>
              <p className="text-[11.5px] text-[var(--sanba-muted)]">{r.effect ?? "—"}</p>
            </div>
            <div className="flex-1 rounded-[9px] bg-[var(--sanba-surface)] px-[9px] py-2">
              <span className="text-[10px] font-bold text-[#9c6b0e]">⚠ 留意</span>
              <p className="text-[11.5px] text-[var(--sanba-muted)]">{r.caution ?? "—"}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
