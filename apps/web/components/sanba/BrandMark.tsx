import * as React from "react";

/**
 * SANBA のシンボルマーク（棒人間「サンバさん」＋胸の山吹の産章）だけを描く SVG。
 * ワードマークやレイアウトは持たず、`className` でサイズを与えて使う。
 * ロゴ（Logo）・ログイン画面・読み込みスプラッシュ（BrandSplash）が同一の実体を共有し、
 * アプリアイコン（`app/icon.svg`）とも系譜を合わせる。
 *
 * 既定では装飾用のマークを想定し a11y 属性は付けない。単独で意味を持たせる場合は
 * 呼び出し側で `role="img"` / `aria-label` を、隣にワードマーク等がある場合は
 * `aria-hidden` を渡す。
 */
export function BrandMark({ className, ...props }: React.SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 40 44"
      className={className}
      fill="none"
      stroke="var(--sanba-frame)"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="20" cy="10" r="5.4" fill="var(--sanba-surface)" />
      <line x1="20" y1="15.4" x2="20" y2="27" />
      <line x1="20" y1="21" x2="13" y2="27.5" />
      <line x1="20" y1="21" x2="27" y2="27.5" />
      <line x1="20" y1="27" x2="13.5" y2="40" />
      <line x1="20" y1="27" x2="26.5" y2="40" />
      <circle cx="20" cy="22.4" r="3" fill="var(--sanba-gold)" strokeWidth={1.6} />
    </svg>
  );
}
