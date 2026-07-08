"use client";

import { useRouter } from "next/navigation";

import { AppHeader, Button, Card, CardTitle, HelpIcon, Screen } from "@/components/sanba";

export function AccessErrorScreen() {
  const router = useRouter();
  return (
    <Screen className="px-4 py-3">
      <AppHeader title="アクセスできません" />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        <Card>
          <CardTitle>アクセスできません</CardTitle>
          <p role="alert" className="text-[13px] leading-relaxed text-sanba-cream">
            指定された URL が存在しないか、アクセスする権限がありません。
          </p>
          <p className="text-[12px] leading-relaxed text-sanba-muted">
            URL に間違いがないかご確認ください。このアプリの会話に参加するには、アプリのオーナーからメンバー招待
            <HelpIcon term="メンバー招待" className="align-[-2px]" />
            を受ける必要があります。
          </p>
          <Button variant="gold" block onClick={() => router.push("/")}>
            ホームへ戻る
          </Button>
        </Card>
      </main>
    </Screen>
  );
}
