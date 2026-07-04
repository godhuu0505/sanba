"use client";

// 問いピンのコンテナ。useChoiceDisclosure（4モード）と strip/detail/compare を結線する。
// 仕様: docs/design/conversation-experience.md §4。
// 親は question/options/detectionKind を渡し、回答は onAnswer(index) で受け取る。
// 回答すると select で選択肢UIは閉じ（hidden）、次の問いで再表示される。

import { useEffect } from "react";

import { useChoiceDisclosure } from "@/lib/useChoiceDisclosure";

import type { DetectionKind } from "@/lib/realtime/types";

import { ChoiceCompareSheet } from "./ChoiceCompareSheet";
import { ChoiceDetailSheet } from "./ChoiceDetailSheet";
import { ChoiceStrip } from "./ChoiceStrip";

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
  /**
   * 問いの一意 ID（検知 ID / ターン ID など）。文言・選択肢数が同じ「次の問い」でも
   * これが変われば再表示する。未指定時は question/選択肢数の変化のみで再表示する。
   */
  questionId?: string;
  question: string;
  options: ChoiceOptionFull[];
  detectionKind?: DetectionKind;
  onAnswer: (index: number) => void;
}

export function ChoicePin({ questionId, question, options, detectionKind, onAnswer }: ChoicePinProps) {
  const d = useChoiceDisclosure();
  const { setQuestion, clear } = d;

  // 新しい問いになったら最小構成に開き直す。questionId があればそれを優先の鍵にするため、
  // 同一文言・同数の連続検知（例: 別々の検知で同じ「どちらを採りますか？」2択）でも再表示できる。
  useEffect(() => {
    if (options.length > 0) setQuestion(options.length);
    else clear();
  }, [questionId, question, options.length, setQuestion, clear]);

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
  // リアルタイムに問いが差し替わり選択肢が縮むことがあるため、focused を現在の範囲へ丸める
  // （リセット effect は commit 後に走るので、描画前にここで防御する）。空なら閉じる。
  if (options.length === 0) return null;
  const focused = Math.min(Math.max(d.state.focused, 0), options.length - 1);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={d.closeOverlay}
        className="fixed inset-0 bg-sanba-frame/55"
      />
      <div className="relative">
        {d.state.mode === "detail" ? (
          <ChoiceDetailSheet
            option={options[focused]}
            index={focused}
            total={options.length}
            onSelect={() => answer(focused)}
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
