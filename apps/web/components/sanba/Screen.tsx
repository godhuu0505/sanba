import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SANBA 体験（白い紙×原色、ADR-0025）の地となるサーフェス。
 *
 * 各画面（ホーム/会話/管理 等）のルートに敷き、配下に紙色の下地・ゴシック書体・
 * 墨の既定テキスト色という「文脈」を一括で与える。これにより個々の子要素は
 * 色やフォントを再指定せずに済む。
 *
 * - `bordered` を付けると墨枠付き端末フレームになる（ショーケース用）。
 * - 既定は枠なしで、実画面では全幅・全高に伸びる。
 */
export interface ScreenProps extends React.HTMLAttributes<HTMLDivElement> {
  bordered?: boolean;
}

export function Screen({ className, bordered = false, ...props }: ScreenProps) {
  return (
    <div
      data-sanba-screen=""
      className={cn(
        "sanba-screen-bg sanba-font flex min-h-dvh w-full flex-col text-[var(--sanba-cream)]",
        bordered && "border-[3px] border-[var(--sanba-frame)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * iPhone 13 Pro 実寸（390×844）の端末モック。ショーケースやデザインレビューで
 * 画面を 1 枚絵として並べるためのラッパ。本番レイアウトでは Screen を直接使う。
 */
export interface PhoneFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  /** スクロールする縦長画面向けに高さの固定を外す。 */
  fluidHeight?: boolean;
}

export function PhoneFrame({ className, fluidHeight = false, children, ...props }: PhoneFrameProps) {
  return (
    <div
      className={cn(
        "w-[390px] shrink-0 overflow-hidden rounded-[28px] border-[3px] border-[var(--sanba-frame)]",
        !fluidHeight && "h-[844px]",
        className,
      )}
      {...props}
    >
      <Screen className="h-full sanba-scroll overflow-y-auto">{children}</Screen>
    </div>
  );
}
