"use client";

// 旧 URL /sessions/[id] の互換リダイレクト（ADR-0040）。過去要件の絵巻閲覧は
// /results/[id] へ移設した（/{slug}/sessions/{id} を「会話中のセッション」の URL に
// 譲るため、閲覧系と紛れない名前空間に分離）。共有済みリンク・ブックマークを壊さない。

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LegacySessionRedirect() {
  const router = useRouter();
  const params = useParams<{ id: string }>();

  useEffect(() => {
    router.replace(`/results/${encodeURIComponent(params.id)}`);
  }, [router, params.id]);

  return null;
}
