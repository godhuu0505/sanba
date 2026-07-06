"use client";

// アプリ従属 URL（/{slug}/prepare・/{slug}/sessions/{id}）の複合エラー画面（ADR-0040）。
// 「URL が存在しない」と「権限がない」を意図的に区別しない: API の存在秘匿
// （非関係者は 404 に平す / ADR-0036）と整合させ、応答差で slug の実在を漏らさない。
// 権限が必要な場合はアプリのオーナーに依頼する導線だけを添える。

import { useRouter } from "next/navigation";

import { AppHeader, Button, Card, CardTitle, Screen } from "@/components/sanba";

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
            URL に間違いがないかご確認ください。このアプリの壁打ちに参加するには、
            アプリのオーナーからメンバー招待を受ける必要があります。
          </p>
          <Button variant="gold" block onClick={() => router.push("/")}>
            ホームへ戻る
          </Button>
        </Card>
      </main>
    </Screen>
  );
}
