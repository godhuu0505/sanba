"use client";

import { useEffect, useRef } from "react";
import { Check, ChevronRight, Image as ImageIcon, X } from "lucide-react";

import { HelpIcon } from "@/components/sanba";

import { detectionPresentation } from "../lib/realtime/mapping";
import type { MaterialDetail } from "../lib/realtime/selectors";

export interface MaterialDetailSheetProps {
  detail: MaterialDetail;
  onClose: () => void;
  onConfirmInConversation?: () => void;
}

const CONFLICT = detectionPresentation("contradiction");

export function MaterialDetailSheet({
  detail,
  onClose,
  onConfirmInConversation,
}: MaterialDetailSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = "material-detail-title";

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = sheetRef.current;
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
  }, [onClose]);

  const done = detail.status === "done";
  const ready = detail.analysisReady;
  const waiting = done
    ? "解析結果はこの場では取得できていません。"
    : "解析が終わると、ここに表示されます。";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={onClose}
        className="absolute inset-0 bg-sanba-frame/55"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[85vh] w-full max-w-[420px] flex-col gap-3 overflow-y-auto rounded-t-[18px] border-t-2 border-sanba-frame bg-sanba-surface px-4 pb-[18px] pt-[12px]"
      >
        <div className="flex items-center gap-2">
          <span id={titleId} className="text-[15px] font-bold text-sanba-gold-text">
            参考資料の詳細
          </span>
          <span className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex size-[26px] items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-[12px] text-sanba-muted"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div
          aria-hidden="true"
          className="flex h-[140px] items-center justify-center gap-1.5 rounded-[12px] border border-sanba-border bg-sanba-surface-strong text-[13px] text-sanba-muted"
        >
          <ImageIcon size={16} aria-hidden /> {detail.name}
        </div>

        <div className="flex flex-col gap-[6px]">
          <span className="text-[11.5px] font-bold text-sanba-cream">{detail.name}</span>
          {done ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-sanba-speak-text">
              <Check size={13} aria-hidden /> 解析済
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-sanba-muted">解析中</span>
              <HelpIcon term="解析" />
              <div
                role="progressbar"
                aria-valuenow={detail.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="解析の進捗"
                className="h-[5px] flex-1 overflow-hidden rounded-full bg-sanba-border"
              >
                <div className="sanba-gold-gradient h-full" style={{ width: `${detail.pct}%` }} />
              </div>
              <span className="text-[11px] font-bold text-sanba-gold-text">{detail.pct}%</span>
            </div>
          )}
        </div>

        <section aria-label="抽出した要件" className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[12px] font-bold text-sanba-gold-text">抽出した要件</span>
            <HelpIcon term="抽出した要件" />
          </div>
          {detail.extracted.length > 0 ? (
            <ul className="flex list-none flex-wrap gap-[6px] p-0">
              {detail.extracted.map((e, i) => (
                <li
                  key={`${e}-${i}`}
                  className="rounded-[999px] border border-sanba-gold-deep bg-sanba-surface-strong px-[11px] py-[6px] text-[12px] font-bold text-sanba-gold-text"
                >
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-sanba-muted">
              {ready ? "抽出された要件はありません。" : waiting}
            </p>
          )}
        </section>

        <section aria-label="言葉と画像の食い違い" className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[12px] font-bold" style={{ color: CONFLICT.color }}>
              言葉と画像の食い違い
            </span>
            <HelpIcon term="言葉と画像の食い違い" />
          </div>
          {detail.conflicts.length > 0 ? (
            detail.conflicts.map((c, i) => (
              <div
                key={`${c.summary}-${i}`}
                className="flex flex-col gap-[6px] rounded-[12px] border-[1.5px] px-[12px] py-[11px]"
                style={{ borderColor: CONFLICT.color, background: "var(--sanba-rec-pale)" }}
              >
                <span
                  role="status"
                  aria-label={CONFLICT.ariaLabel}
                  className="inline-flex w-fit items-center gap-1 rounded-[999px] px-[7px] py-[2px] text-[10px] font-bold text-white"
                  style={{ background: CONFLICT.color }}
                >
                  <CONFLICT.Icon size={11} aria-hidden />
                  <span>言葉と画像の食い違い</span>
                </span>
                <span className="text-[12.5px] text-sanba-cream">{c.summary}</span>
                {onConfirmInConversation && (
                  <button
                    type="button"
                    onClick={onConfirmInConversation}
                    className="inline-flex w-fit items-center gap-[2px] text-[11px] font-bold text-sanba-gold-text"
                  >
                    会話で確認 <ChevronRight size={11} aria-hidden />
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="text-[11.5px] text-sanba-muted">
              {ready ? "言葉と画像の食い違いは見つかっていません。" : waiting}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
