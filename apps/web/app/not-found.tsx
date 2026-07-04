import Link from "next/link";

import { AppHeader, Button, Figure, Screen } from "@/components/sanba";

/**
 * 404。白い紙×原色×棒人間（ADR-0025）の意匠で、迷子をホームへ導く。
 * サンバさん（問いかけ）が「この頁は見当たりませぬ」と首をかしげる。
 */
export default function NotFound() {
  return (
    <Screen>
      {/* どの画面でも SANBA ヘッダー（2026-07 要望）。迷子の頁でもブランドを保つ。 */}
      <AppHeader />
      <div className="mx-auto flex w-full max-w-90 flex-1 flex-col items-center justify-center gap-3.5 px-6 py-10 text-center">
        <Figure state="asking" className="w-[84px]" label="頁が見つからず首をかしげる棒人間" />
        <p className="text-[13px] font-bold tracking-[0.3em] text-[var(--sanba-muted)]">404</p>
        <h1 className="sanba-display text-[22px] font-bold text-[var(--sanba-cream)]">
          この頁は見当たりませぬ
        </h1>
        <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
          お探しの頁は移されたか、はじめから無かったのかもしれません。
        </p>
        <Button asChild variant="gold" size="lg" block className="mt-2">
          <Link href="/">ホームへ戻る</Link>
        </Button>
      </div>
    </Screen>
  );
}
