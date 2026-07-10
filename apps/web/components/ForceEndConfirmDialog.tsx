"use client";

import { Scale } from "lucide-react";

export interface ForceEndConfirmDialogProps {
  onProvisional: () => void;
  onCancel: () => void;
}

export function ForceEndConfirmDialog({ onProvisional, onCancel }: ForceEndConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sanba-frame/55 px-4">
      <div
        role="dialog"
        aria-label="未解消のまま終える確認"
        aria-modal="true"
        className="flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-sanba-frame bg-sanba-surface px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
      >
        <div
          className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
          style={{ borderColor: "var(--sanba-gold-deep)", color: "var(--sanba-gold-text)" }}
        >
          <Scale size={22} aria-hidden />
        </div>
        <p className="text-center text-[16px] font-bold text-sanba-gold-text">未解消のまま終えますか？</p>
        <p className="text-center text-[12px] text-sanba-muted">
          未解消の項目が残っています。このまま終えても、これまでの要件はサーバ側で保全され、結果画面から Issue も起票できます。
        </p>
        <div className="flex w-full flex-col gap-2">
          <button
            type="button"
            onClick={onProvisional}
            className="w-full rounded-[12px] bg-sanba-gold py-[13px] text-[13px] font-bold text-sanba-ink"
          >
            確定せず終える
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full py-[6px] text-[12px] font-bold text-sanba-muted"
          >
            会話に戻る
          </button>
        </div>
      </div>
    </div>
  );
}
