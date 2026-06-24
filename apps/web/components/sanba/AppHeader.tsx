import * as React from "react";

import { cn } from "@/lib/utils";
import { Logo } from "./Logo";

/**
 * 画面上部のアプリバー。2 系統を 1 つで賄う:
 *  - 戻る導線つき（管理/準備など）: `onBack` か `back` を渡す。
 *  - ブランド提示（ログイン等）: `brand` を渡すとロゴ＋ワードマークを出す。
 * 右端には REC バッジ等を `right` スロットで差し込める。
 */
export interface AppHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  /** 戻るボタンを表示し、押下時に呼ぶ。 */
  onBack?: () => void;
  /** onBack なしで戻る見た目だけ欲しい場合に true。 */
  back?: boolean;
  /** タイトルの代わりにロゴ＋ワードマークを出す。 */
  brand?: boolean;
  /** 右端スロット（REC バッジ・補助操作など）。 */
  right?: React.ReactNode;
}

export function AppHeader({
  className,
  title,
  onBack,
  back,
  brand,
  right,
  ...props
}: AppHeaderProps) {
  const showBack = back || typeof onBack === "function";
  return (
    <header
      className={cn("flex w-full items-center gap-[10px] px-[16px] py-[6px]", className)}
      {...props}
    >
      {showBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] text-[16px] text-[var(--sanba-cream)] transition-colors hover:border-[var(--sanba-frame)]"
        >
          ‹
        </button>
      )}
      {brand ? (
        <Logo size="md" />
      ) : (
        <h1 className="text-[15px] font-bold text-[var(--sanba-cream)]">{title}</h1>
      )}
      {right != null && <div className="ml-auto flex items-center">{right}</div>}
    </header>
  );
}
