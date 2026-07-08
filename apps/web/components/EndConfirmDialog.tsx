"use client";

import { Scale, TriangleAlert } from "lucide-react";

export interface EndConfirmDialogProps {
  unresolved: number;
  onContinue: () => void;
  onEnd: () => void;
}

export function EndConfirmDialog({ unresolved, onContinue, onEnd }: EndConfirmDialogProps) {
  const hasUnresolved = unresolved > 0;
  return (
    <div
      role="dialog"
      aria-label="終了確認"
      aria-modal="true"
      className="flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-sanba-frame bg-sanba-surface px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
    >
      <div
        className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
        style={{
          borderColor: hasUnresolved ? "var(--sanba-rec)" : "var(--sanba-gold-deep)",
          color: hasUnresolved ? "var(--sanba-rec)" : "var(--sanba-gold-text)",
        }}
      >
        {hasUnresolved ? <TriangleAlert size={22} aria-hidden /> : <Scale size={22} aria-hidden />}
      </div>
      <p className="text-center text-[16px] font-bold text-sanba-gold-text">会話を終えますか？</p>
      <p className="text-center text-[12px] text-sanba-muted">
        {hasUnresolved
          ? `未解消が ${unresolved} 件 残っています。終えると、その分は確定されません。`
          : "未解消はありません。いつでも確定できます。"}
      </p>
      <div className="flex w-full gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 rounded-[12px] border border-sanba-frame py-[13px] text-[13px] font-bold text-sanba-gold-text"
        >
          会話を続ける
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="flex-1 rounded-[12px] bg-sanba-rec-text py-[13px] text-[13px] font-bold text-white"
        >
          終了する
        </button>
      </div>
    </div>
  );
}
