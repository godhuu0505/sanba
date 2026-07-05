import { ChevronLeft } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Logo } from "./Logo";

/**
 * 画面上部のアプリバー。SANBA ブランド（ロゴ＋ワードマーク）を**全画面共通で常時表示**する
 * （2026-07 要望「どの画面でも SANBA のヘッダー」）。
 *  - タイトル画面（管理/準備など）: `title` を渡すと小ロゴ＋縦罫で併記する。
 *  - 戻る導線: `onBack` か `back` を渡す。
 *  - 右端には REC バッジ・アカウントメニュー等を `right` スロットで差し込める。
 */
export interface AppHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  /** 戻るボタンを表示し、押下時に呼ぶ。 */
  onBack?: () => void;
  /** onBack なしで戻る見た目だけ欲しい場合に true。 */
  back?: boolean;
  /**
   * @deprecated ロゴは常時表示になったため無指定と同義。既存呼び出し（改修中ファイル含む）を
   * 壊さないため受け付けだけ残す。新規コードでは渡さない。
   */
  brand?: boolean;
  /** 右端スロット（REC バッジ・補助操作など）。 */
  right?: React.ReactNode;
}

export function AppHeader({
  className,
  title,
  onBack,
  back,
  // brand は deprecated（ロゴ常時表示）。DOM へ流出させないため destructure で捨てる。
  brand: _brand,
  right,
  ...props
}: AppHeaderProps) {
  const showBack = back || typeof onBack === "function";
  const hasTitle = title != null && title !== "";
  return (
    <header
      className={cn("flex w-full items-center gap-2.5 px-4 py-1.5", className)}
      {...props}
    >
      {showBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="flex size-7.5 shrink-0 items-center justify-center rounded-[10px] border-[1.5px] border-sanba-frame bg-sanba-surface text-sanba-cream transition-[box-shadow,transform] hover:shadow-[2px_2px_0_var(--sanba-shadow)]"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
      )}
      {/* SANBA ブランドは全画面で出す。タイトルがある画面は小ロゴ＋縦罫で場所を譲る。 */}
      <Logo size={hasTitle ? "sm" : "md"} className="shrink-0" />
      {hasTitle && (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-sanba-border-strong" />
          <h1 className="truncate text-[15px] font-bold text-sanba-cream">{title}</h1>
        </>
      )}
      {right != null && <div className="ml-auto flex items-center">{right}</div>}
    </header>
  );
}
