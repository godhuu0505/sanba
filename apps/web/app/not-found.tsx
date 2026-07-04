import Link from "next/link";

import { Button, Figure, Screen } from "@/components/sanba";

/**
 * 404。白い紙×原色×棒人間（ADR-0025）の意匠で、迷子をホームへ導く。
 * サンバさん（問いかけ）が「この頁は見当たりませぬ」と首をかしげる。
 */
export default function NotFound() {
  return (
    <Screen className="items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[360px] flex-col items-center gap-[14px] text-center">
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
