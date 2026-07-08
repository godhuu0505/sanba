"use client";

import { Scale } from "lucide-react";

export interface ForceEndConfirmDialogProps {
  busy?: boolean;
  onFinalize: () => void;
  onProvisional: () => void;
  onCancel: () => void;
  notice?: string;
}

export function ForceEndConfirmDialog({
  busy,
  onFinalize,
  onProvisional,
  onCancel,
  notice,
}: ForceEndConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sanba-frame/55 px-4">
      <div
        role="dialog"
        aria-label="確定して締める確認"
        aria-modal="true"
        className="flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-sanba-frame bg-sanba-surface px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
      >
        <div
          className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
          style={{ borderColor: "var(--sanba-gold-deep)", color: "var(--sanba-gold-text)" }}
        >
          <Scale size={22} aria-hidden />
        </div>
        <p className="text-center text-[16px] font-bold text-sanba-gold-text">確定して締めますか？</p>
        <p className="text-center text-[12px] text-sanba-muted">
          確定すると要件が保全され、Issue 起票もできます。確定せずに終えると、内容はサーバ側で保全されます。
        </p>
        {notice && (
          <p role="alert" className="text-center text-[12px] text-sanba-rec-text">
            {notice}
          </p>
        )}
        <div className="flex w-full flex-col gap-2">
          <button
            type="button"
            onClick={onFinalize}
            disabled={busy}
            className="w-full rounded-[12px] bg-sanba-gold py-[13px] text-[13px] font-bold text-sanba-ink disabled:opacity-60"
          >
            {busy ? "確定中…" : "確定して終える"}
          </button>
          <button
            type="button"
            onClick={onProvisional}
            disabled={busy}
            className="w-full rounded-[12px] border border-sanba-frame py-[13px] text-[13px] font-bold text-sanba-gold-text disabled:opacity-60"
          >
            確定せず終える
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-full py-[6px] text-[12px] font-bold text-sanba-muted disabled:opacity-60"
          >
            会話に戻る
          </button>
        </div>
      </div>
    </div>
  );
}
