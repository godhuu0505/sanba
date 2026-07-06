"use client";

// 旧 URL /prepare の互換リダイレクト（ADR-0045）。セッション準備はアプリ従属 URL
// /{slug}/prepare へ移した（対象アプリの選択は 01 ホームの開始ゲート / ADR-0044）。
// 選択済みアプリは sessionStorage（prepFormStorage）で保たれるため、ホームへ戻しても
// ワンクリックで準備へ進める。ブックマーク・共有済みリンクを 404 にしない。

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LegacyPrepareRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
