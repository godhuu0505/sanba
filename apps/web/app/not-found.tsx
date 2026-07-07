import Link from "next/link";

import { AppHeader, Button, Figure, Screen } from "@/components/sanba";

export default function NotFound() {
  return (
    <Screen>
      <AppHeader />
      <div className="mx-auto flex w-full max-w-90 flex-1 flex-col items-center justify-center gap-3.5 px-6 py-10 text-center">
        <Figure state="asking" className="w-[84px]" label="頁が見つからず首をかしげる棒人間" />
        <p className="text-[13px] font-bold tracking-[0.3em] text-sanba-muted">404</p>
        <h1 className="sanba-display text-[22px] font-bold text-sanba-cream">
          この頁は見当たりませぬ
        </h1>
        <p className="text-[13px] leading-relaxed text-sanba-muted">
          お探しの頁は移されたか、はじめから無かったのかもしれません。
        </p>
        <Button asChild variant="gold" size="lg" block className="mt-2">
          <Link href="/">ホームへ戻る</Link>
        </Button>
      </div>
    </Screen>
  );
}
