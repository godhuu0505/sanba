"use client";

// 素材の中断確認ダイアログ（#219 / Figma 222:2）。解析/アップロード中の素材を中断する前に、
// 「途中までの結果は破棄されます」を提示して確認する。確定で破棄、続けるで継続。
// a11y: 暗幕＋role=dialog/aria-modal＋フォーカストラップ＋ESC は MaterialSourceSheet /
// ChoiceDetailSheet のパターンに倣う（見た目に依らない現代語ラベル・ADR-0017）。

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface MaterialCancelDialogProps {
  /** 中断対象の素材名（確認文に出す）。 */
  materialName: string;
  /** 「続ける」= 中断しない（ダイアログを閉じる・背景/ESC も同じ）。 */
  onContinue: () => void;
  /** 「中断する」= 確定（途中までの結果を破棄）。 */
  onConfirm: () => void;
}

export function MaterialCancelDialog({
  materialName,
  onContinue,
  onConfirm,
}: MaterialCancelDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // 破壊的操作なので既定フォーカスは安全側の「続ける」に置く。
  const continueRef = useRef<HTMLButtonElement>(null);

  // 開いたらダイアログ内へフォーカスを移す（a11y）。
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  // ESC で閉じる（=続ける）＋Tab をダイアログ内に閉じ込める（フォーカストラップ・a11y）。
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
      {/* 暗幕（MaterialSourceSheet 踏襲）。クリックで閉じる（=続ける）。 */}
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={onContinue}
        className="absolute inset-0 bg-black/55"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="中断の確認"
        className="relative z-10 flex w-[318px] flex-col items-center gap-3 rounded-[16px] border-2 border-[var(--sanba-frame)] bg-[var(--sanba-surface)] px-[18px] pb-4 pt-[18px] shadow-[4px_4px_0_var(--sanba-shadow)]"
      >
        <div
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full border-2 text-[22px] font-bold"
          style={{ borderColor: "var(--sanba-rec)", color: "var(--sanba-rec)" }}
        >
          <X size={22} aria-hidden />
        </div>
        <p className="text-center text-[16px] font-bold text-[var(--sanba-gold-text)]">
          中断しますか？
        </p>
        <p className="text-center text-[12px] text-[var(--sanba-muted)]">
          「{materialName}」の解析を中断します。途中までの結果は破棄されます。
        </p>
        <div className="flex w-full gap-2">
          <button
            ref={continueRef}
            type="button"
            onClick={onContinue}
            className="flex-1 rounded-[12px] border border-[var(--sanba-frame)] py-[13px] text-[13px] font-bold text-[var(--sanba-gold-text)]"
          >
            続ける
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-[12px] bg-[var(--sanba-rec)] py-[13px] text-[13px] font-bold text-white"
          >
            中断する
          </button>
        </div>
      </div>
    </div>
  );
}
