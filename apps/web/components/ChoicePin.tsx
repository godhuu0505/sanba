"use client";

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
  questionId?: string;
  question: string;
  options: ChoiceOptionFull[];
  detectionKind?: DetectionKind;
  onAnswer: (index: number) => void;
}

export function ChoicePin({ questionId, question, options, detectionKind, onAnswer }: ChoicePinProps) {
  const d = useChoiceDisclosure();
  const { setQuestion, clear } = d;

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
