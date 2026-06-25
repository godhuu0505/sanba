"use client";

// 問いピン（選択肢）の最小構成 / 一覧（展開カード）を描くプレゼン部品。
// 仕様: docs/design/conversation-experience.md §4。
// - min : 問い1行＋横スクロールchip（タップ=回答）＋『広げる』。
// - list: 行（タップ=即選択）＋各行『詳細›』（動的選択肢のみ）＋『閉じる』。
// 検知（矛盾/抜け）はバッジ＋枠色で示す（色のみ依存しない・ADR-0017）。
// 詳細/比較のオーバーレイは別部品（ChoiceDetailSheet など）が担当する。

export interface ChoiceOption {
  label: string;
  /** サブ説明（一覧で表示）。 */
  sub?: string;
  /** 常設選択肢（その他/保留など・詳細を持たない）。 */
  fixed?: boolean;
}

export type DetectionKind = "contradiction" | "gap";

export interface ChoiceStripProps {
  mode: "min" | "list";
  question: string;
  options: ChoiceOption[];
  onSelect: (index: number) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onOpenDetail: (index: number) => void;
  /** 検知由来の問いのとき種別を渡す（undefined=通常）。 */
  detectionKind?: DetectionKind;
}

const DETECTION = {
  contradiction: { label: "矛盾を検知", color: "#d2564b" },
  gap: { label: "抜けを検知", color: "#e0a93b" },
} as const;

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
  if (options.length === 0) return null;

  const accent = detectionKind ? DETECTION[detectionKind].color : "#7a5a1e";

  return (
    <div
      className="flex flex-col gap-2 border-t-2 bg-[#1f1710] px-4 py-[9px]"
      style={{ borderTopColor: accent }}
    >
      {/* 見出し：検知バッジ＋問い＋開閉 */}
      <div className="flex items-center gap-2">
        {detectionKind && (
          <span
            className="rounded-full px-2 py-[2px] text-[10.5px] font-bold text-[var(--sanba-ink)]"
            style={{ backgroundColor: DETECTION[detectionKind].color }}
          >
            {DETECTION[detectionKind].label}
          </span>
        )}
        <span className="text-[12px] font-bold text-[var(--sanba-gold-text)]">{question}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={mode === "min" ? onExpand : onCollapse}
          className="rounded-full border border-[var(--sanba-frame)] bg-[var(--sanba-surface)] px-[9px] py-1 text-[10.5px] font-bold text-[var(--sanba-gold-text)]"
        >
          {mode === "min" ? "⤢ 広げる" : "⤡ 閉じる"}
        </button>
      </div>

      {mode === "min" ? (
        <div className="flex gap-[6px] overflow-x-auto">
          {options.map((o, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className={`shrink-0 rounded-full border px-[11px] py-[6px] text-[12px] font-bold ${
                o.fixed
                  ? "border-dashed border-[#6b5836] text-[var(--sanba-muted)]"
                  : "border-[var(--sanba-frame)] bg-[var(--sanba-surface)] text-[var(--sanba-gold-text)]"
              }`}
            >
              {o.label}
            </button>
          ))}
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
                    ? "border-dashed border-[#6b5836] bg-[#241a0f]"
                    : "border-[var(--sanba-border)] bg-[var(--sanba-surface)]"
                }`}
              >
                <span className="text-[13px] font-bold text-[var(--sanba-cream)]">{o.label}</span>
                {o.sub && <span className="text-[10.5px] text-[var(--sanba-muted)]">{o.sub}</span>}
              </button>
              {!o.fixed && (
                <button
                  type="button"
                  onClick={() => onOpenDetail(i)}
                  className="shrink-0 rounded-full border border-[var(--sanba-frame)] px-[9px] py-[5px] text-[10.5px] font-bold text-[var(--sanba-gold-text)]"
                >
                  詳細 ›
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
