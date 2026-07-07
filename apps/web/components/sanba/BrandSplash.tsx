import * as React from "react";

import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Screen } from "./Screen";

/**
 * 認証解決（GIS の静かな再取得）を待つ間の中立スプラッシュ（ADR-0052）。
 *
 * SANBA は ID トークンを永続化しない（ADR-0014 §7 / XSS 回避）ため、フルロード時は
 * GIS の auto_select で credential を取り直すまで一瞬だけ待つ。ここで「ログイン状態を
 * 確認しています」のようなログインし直しを想起させる文言を出すと、ログイン済みの利用者に
 * 「毎回ログインさせられている」と映る。復元はほぼ成功する前提なので、ブランドの立ち上がり
 * （＝アプリ読み込み）としてだけ見せ、そのまま画面に入れたように感じさせる。
 *
 * 視覚は SANBA マークの淡い明滅のみ。状態は `role="status"` で読み上げる（既定「読み込み中」）。
 */
export interface BrandSplashProps {
  /** スクリーンリーダー向けの状態ラベル。視覚的には出さない。 */
  label?: string;
  className?: string;
}

export function BrandSplash({ label = "読み込み中", className }: BrandSplashProps) {
  return (
    <Screen className={cn("items-center justify-center", className)}>
      <div role="status" aria-label={label} className="flex flex-col items-center gap-4">
        <BrandMark className="h-16 w-auto motion-safe:animate-pulse" aria-hidden />
        <span className="sanba-display text-[20px] font-bold tracking-wide text-sanba-cream">
          SANBA
        </span>
      </div>
    </Screen>
  );
}
