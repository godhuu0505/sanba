"use client";

import { Check, Sparkles } from "lucide-react";

export interface EndProposalCardProps {
  requirementCount: number;
  materialCount: number;
  busy?: boolean;
  onAgree: () => void;
  onContinue: () => void;
}

export function EndProposalCard({
  requirementCount,
  materialCount,
  busy = false,
  onAgree,
  onContinue,
}: EndProposalCardProps) {
  return (
    <div
      role="region"
      aria-label="終了の提案"
      className="rounded-[14px] border-[1.5px] border-sanba-gold-deep bg-sanba-gold-pale px-[14px] py-[12px]"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-sanba-gold-text">
        <Sparkles size={15} aria-hidden />
        終了の提案が届いています
      </p>
      <p className="mt-[6px] text-[12px] text-sanba-cream">
        確認したかった点はすべて解消できました。要件をまとめて、今日の会話を終えてもよいですか。
      </p>
      <p className="mt-[4px] text-[10.5px] text-sanba-muted">
        要件 {requirementCount} 件 · 参考資料 {materialCount} 件 · 音声でも「はい」で同意できます
      </p>
      <div className="mt-[10px] flex gap-[8px]">
        <button
          type="button"
          disabled={busy}
          onClick={onAgree}
          className="inline-flex items-center gap-1.5 rounded-[12px] border-[1.5px] border-sanba-frame bg-sanba-rec px-[14px] py-[8px] text-[12.5px] font-bold text-white disabled:opacity-60"
        >
          <Check size={14} aria-hidden />
          {busy ? "まとめています…" : "同意して終了"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="rounded-[12px] border border-sanba-border bg-sanba-surface px-[14px] py-[8px] text-[12.5px] text-sanba-muted disabled:opacity-60"
        >
          まだ続ける
        </button>
      </div>
    </div>
  );
}
