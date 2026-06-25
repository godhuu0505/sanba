"use client";

// 問いピンのコンテナ。useChoiceDisclosure（4モード）と strip/detail/compare を結線する。
// 仕様: docs/design/conversation-experience.md §4。
// 親は question/options/detectionKind を渡し、回答は onAnswer(index) で受け取る。
// 回答すると select で選択肢UIは閉じ（hidden）、次の問いで再表示される。

import { useEffect } from "react";

import { useChoiceDisclosure } from "@/lib/useChoiceDisclosure";

import { ChoiceCompareSheet } from "./ChoiceCompareSheet";
import { ChoiceDetailSheet } from "./ChoiceDetailSheet";
import { ChoiceStrip, type DetectionKind } from "./ChoiceStrip";

export interface ChoiceOptionFull {
  label: string;
  sub?: string;
  fixed?: boolean;
  how?: string;
  effect?: string;
  caution?: string;
  source?: string;
}

export interface ChoicePinProps {
  question: string;
  options: ChoiceOptionFull[];
  detectionKind?: DetectionKind;
  onAnswer: (index: number) => void;
}

export function ChoicePin({ question, options, detectionKind, onAnswer }: ChoicePinProps) {
  const d = useChoiceDisclosure();
  const { setQuestion, clear } = d;

  // 問い（や選択肢数）が変わったら最小構成に開き直す。
  useEffect(() => {
    if (options.length > 0) setQuestion(options.length);
    else clear();
  }, [question, options.length, setQuestion, clear]);

  if (d.state.mode === "hidden") return null;

  const answer = (i: number) => {
    d.select(i);
    onAnswer(i);
  };

  if (d.state.mode === "min" || d.state.mode === "list") {
    return (
      <ChoiceStrip
        mode={d.state.mode}
        question={question}
        options={options}
        detectionKind={detectionKind}
        onSelect={answer}
        onExpand={d.expand}
        onCollapse={d.collapse}
        onOpenDetail={d.openDetail}
      />
    );
  }

  // detail / compare はオーバーレイ（暗幕＋ボトムシート）。
  // 問い差替え直後に focused が範囲外になる描画サイクルを防ぐためクランプする。
  const safeIndex = options.length > 0 ? Math.min(d.state.focused, options.length - 1) : 0;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={d.closeOverlay}
        className="fixed inset-0 bg-black/55"
      />
      <div className="relative">
        {d.state.mode === "detail" ? (
          <ChoiceDetailSheet
            option={options[safeIndex]}
            index={safeIndex}
            total={options.length}
            onSelect={() => answer(safeIndex)}
            onPrev={d.prev}
            onNext={d.next}
            onClose={d.closeOverlay}
            onCompare={d.openCompare}
          />
        ) : (
          <ChoiceCompareSheet
            rows={options.map((o) => ({ label: o.label, effect: o.effect, caution: o.caution }))}
            onSelect={answer}
            onClose={d.closeOverlay}
          />
        )}
      </div>
    </div>
  );
}
