import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 画面下からせり上がるシート。矛盾検知の裁定や選択肢の提示に使う。
 * ドラッグハンドル＋見出し（任意で緋=矛盾の色）＋本文＋操作スロットで構成。
 * オーバーレイ/開閉アニメは利用側に委ね、ここは見た目と構造に徹する。
 */
export interface BottomSheetProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  /** 見出しの色。矛盾系は "danger"（緋）。 */
  tone?: "danger" | "neutral";
  /** 本文下に並べる操作（ボタン等）。 */
  actions?: React.ReactNode;
}

export function BottomSheet({
  className,
  title,
  tone = "danger",
  actions,
  children,
  ...props
}: BottomSheetProps) {
  return (
    <div
      role="dialog"
      className={cn(
        "flex w-full flex-col gap-[12px] rounded-t-[18px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[18px] pb-[20px] pt-[10px]",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="mx-auto h-[4px] w-[40px] shrink-0 rounded-full bg-[var(--sanba-border-strong)]"
      />
      {title != null && (
        <h2
          className={cn(
            "text-[15px] font-bold",
            tone === "danger" ? "text-[var(--sanba-rec)]" : "text-[var(--sanba-cream)]",
          )}
        >
          {title}
        </h2>
      )}
      {children && (
        <div className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">{children}</div>
      )}
      {actions && <div className="flex flex-col gap-[8px]">{actions}</div>}
    </div>
  );
}
