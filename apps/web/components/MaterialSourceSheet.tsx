"use client";


import { Camera, ChevronRight, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export type MaterialSource = "camera" | "upload";

export interface MaterialSourceSheetProps {
  onClose: () => void;
  onUpload: () => void;
  onToggleCamera?: () => void;
  cameraActive?: boolean;
  onSelectSource?: (source: MaterialSource) => void;
  error?: string | null;
  placement?: "bottom" | "center";
}

export function MaterialSourceSheet({
  onClose,
  onUpload,
  onToggleCamera,
  cameraActive,
  onSelectSource,
  error,
  placement = "bottom",
}: MaterialSourceSheetProps) {
  const centered = placement === "center";
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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

  function pick(source: MaterialSource, action?: () => void) {
    onSelectSource?.(source);
    action?.();
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center ${
        centered ? "items-center px-4" : "items-end"
      }`}
    >
      {}
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
        aria-label="参考資料の追加方法"
        className={`relative z-10 flex w-full max-w-[420px] flex-col gap-2 border-sanba-frame bg-sanba-surface px-4 pb-[18px] pt-[14px] ${
          centered ? "rounded-[18px] border-2" : "rounded-t-[18px] border-t-2"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-sanba-gold-text">
            参考資料の追加方法を選ぶ
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
        <p className="text-[12px] text-sanba-muted">
          言葉以外の情報（画像・資料・カメラ）も、会話を止めずに渡せます。
        </p>

        {onToggleCamera && (
          <SourceRow
            icon={<Camera size={20} />}
            title="カメラで撮影"
            sub="ホワイトボード／手書き（撮影して渡す）"
            active={cameraActive}
            actionLabel="カメラの起動/停止"
            onClick={() => pick("camera", onToggleCamera)}
          />
        )}

        <SourceRow
          icon={<Upload size={20} />}
          title="ファイルをアップロード"
          sub="対応形式は PNG / JPEG / Markdown / CSV / PDF のみです"
          onClick={() => pick("upload", onUpload)}
        />

        {error && (
          <p role="alert" className="px-1 text-[11.5px] font-bold text-sanba-rec-text">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-1 rounded-[12px] border border-sanba-border py-[12px] text-center text-[13px] font-bold text-sanba-muted"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

function SourceRow({
  icon,
  title,
  sub,
  active,
  actionLabel,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  active?: boolean;
  actionLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={actionLabel}
      aria-pressed={active}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[12px] border bg-sanba-surface-strong px-3 py-[13px] text-left"
      style={{ borderColor: active ? "var(--sanba-gold-text)" : "var(--sanba-border)" }}
    >
      <span aria-hidden="true" className="text-[20px]">
        {icon}
      </span>
      <span className="flex flex-1 flex-col gap-[2px]">
        <span className="flex items-center gap-2 text-[14px] font-bold text-sanba-cream">
          {title}
          {active && (
            <span className="rounded-full bg-sanba-gold-text px-[7px] py-[1px] text-[10px] font-bold text-white">
              ON
            </span>
          )}
        </span>
        <span className="text-[11.5px] text-sanba-muted">{sub}</span>
      </span>
      <span aria-hidden="true" className="text-sanba-muted">
        <ChevronRight size={16} />
      </span>
    </button>
  );
}
