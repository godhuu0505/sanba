"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface MaterialCancelDialogProps {
  materialName: string;
  onContinue: () => void;
  onConfirm: () => void;
}

export function MaterialCancelDialog({
  materialName,
  onContinue,
  onConfirm,
}: MaterialCancelDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onContinue();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinue]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={onContinue}
        className="absolute inset-0 bg-sanba-frame/55"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="中断の確認"
        className="relative z-10 flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-sanba-frame bg-sanba-surface px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
      >
        <div
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
          style={{ borderColor: "var(--sanba-rec)", color: "var(--sanba-rec)" }}
        >
          <X size={22} aria-hidden />
        </div>
        <p className="text-center text-[16px] font-bold text-sanba-gold-text">
          中断しますか？
        </p>
        <p className="text-center text-[12px] text-sanba-muted">
          「{materialName}」の解析を中断します。途中までの結果は破棄されます。
        </p>
        <div className="flex w-full gap-2">
          <button
            ref={continueRef}
            type="button"
            onClick={onContinue}
            className="flex-1 rounded-[12px] border border-sanba-frame py-[13px] text-[13px] font-bold text-sanba-gold-text"
          >
            続ける
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-[12px] bg-sanba-rec-text py-[13px] text-[13px] font-bold text-white"
          >
            中断する
          </button>
        </div>
      </div>
    </div>
  );
}
