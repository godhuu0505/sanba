"use client";

// 02 セッション準備のアプリ従属 URL（/{slug}/prepare / ADR-0040）。入口フローの実体は
// EntryFlow が持ち、ここは slug をルートから渡す薄い入口。直リンク・共有・リロードで
// 準備画面へ到達できる。slug が本人のアプリ一覧に解決できない（不存在・権限なし）ときは
// EntryFlow が複合エラー画面（AccessErrorScreen）を出す。未ログインは authGate が
// /login?next=/{slug}/prepare へ戻す。

import { useParams } from "next/navigation";

import EntryFlow from "@/components/EntryFlow";

export default function SlugPreparePage() {
  const params = useParams<{ slug: string }>();
  return <EntryFlow initialStep="prepare" initialSlug={params.slug} />;
}
