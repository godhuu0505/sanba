"use client";

// 問いピン（選択肢）の最小構成 / 一覧（展開カード）を描くプレゼン部品。
// 仕様: docs/design/conversation-experience.md §4。
// - min : 問い1行＋横スクロールchip（タップ=回答）＋『広げる』。
// - list: 行（タップ=即選択）＋各行『詳細›』（動的選択肢のみ）＋『閉じる』。
// 検知（矛盾/抜け）はバッジ＋枠色で示す（色のみ依存しない・ADR-0017）。
// 詳細/比較のオーバーレイは別部品（ChoiceDetailSheet など）が担当する。

import { useEffect, useRef } from "react";

import { detectionPresentation } from "@/lib/realtime/mapping";
import type { DetectionKind } from "@/lib/realtime/types";

const LONG_PRESS_MS = 450;

export interface ChoiceOption {
  label: string;
  /** サブ説明（一覧で表示）。 */
  sub?: string;
  /** 常設選択肢（その他/保留など・詳細を持たない）。 */
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
  /** 検知由来の問いのとき種別を渡す（undefined=通常）。 */
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
  // 最小chipの長押し近道：押下で計時、しきい値経過で詳細を開き、その後の click 回答を抑止する。
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
  // アンマウント後に詳細を開こうとしないよう、保留タイマーを後始末する。
  useEffect(() => () => window.clearTimeout(pressTimer.current), []);
  const chipClick = (i: number) => {
    if (longPressed.current) {
      longPressed.current = false;
      return; // 長押しで詳細を開いた直後の click は回答にしない。
    }
    onSelect(i);
  };

  if (options.length === 0) return null;

  const presentation = detectionKind ? detectionPresentation(detectionKind) : null;
  const accent = presentation ? presentation.color : "var(--sanba-gold-deep)";

  return (
    <div
      className="flex flex-col gap-2 border-t-2 bg-[var(--sanba-surface-strong)] px-4 py-[9px]"
      style={{ borderTopColor: accent }}
    >
      {/* 見出し：検知バッジ＋問い＋開閉 */}
      <div className="flex items-center gap-2">
        {presentation && (
          <span
            aria-label={presentation.ariaLabel}
            className="rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
            style={{ backgroundColor: presentation.color }}
          >
            {presentation.icon} {presentation.label}
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
          {options.map((o, i) => {
            // 常設（その他/保留）は詳細を持たないため長押し近道なし。
            const longPress = o.fixed
              ? {}
              : {
                  onPointerDown: () => startPress(i),
                  onPointerUp: cancelPress,
                  onPointerLeave: cancelPress,
                  // スクロール等でブラウザがジェスチャーを奪うと pointercancel になる。
                  // ここで止めないと指を離していなくても 450ms 後に詳細が勝手に開く。
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
                    ? "border-dashed border-[var(--sanba-border-strong)] text-[var(--sanba-muted)]"
                    : "border-[var(--sanba-frame)] bg-[var(--sanba-surface)] text-[var(--sanba-gold-text)]"
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
                    ? "border-dashed border-[var(--sanba-border-strong)] bg-[var(--sanba-bg)]"
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
