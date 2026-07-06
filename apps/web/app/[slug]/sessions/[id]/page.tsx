"use client";

// 会話中セッションの固有 URL（/{slug}/sessions/{id} / ADR-0040）への直アクセス・リロードの
// 受け皿。会話そのもの（LiveKit 接続・join トークン）は入口フロー（EntryFlow）の中でしか
// 成立しないため、ここでは slug の解決（= アプリへの権限確認）だけを行い、
// 過去の要件閲覧（/results/{id}）へ送る。解決できない slug（不存在・権限なし）は
// 複合エラー画面に落とす（存在秘匿 / ADR-0036 と整合）。
// 会話中のアドレスバーがこの URL になるのは EntryFlow が History API で書き換えるため
// （remount しないのでこのページは実行されない）。

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AccessErrorScreen } from "@/components/AccessErrorScreen";
import { authGate } from "@/components/RequireAuth";
import { Screen } from "@/components/sanba";
import { fetchMyProducts } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function SlugSessionPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ slug: string; id: string }>();
  const [denied, setDenied] = useState(false);

  // slug が本人のアプリ一覧（owner / member）に解決できるかで権限を判定する。
  // 解決できたら要件の閲覧へ（会話のリロード復帰は持たない: 接続は一本道の中でのみ成立）。
  useEffect(() => {
    if (!auth.devMode && !auth.loggedIn) return;
    let cancelled = false;
    fetchMyProducts(auth.credential)
      .then((products) => {
        if (cancelled) return;
        if (products.some((p) => p.slug === params.slug)) {
          router.replace(`/results/${encodeURIComponent(params.id)}`);
        } else {
          setDenied(true);
        }
      })
      .catch(() => {
        // 取得失敗（ネットワーク等）も権限を確認できないので複合エラーに平す（fail-closed）。
        if (!cancelled) setDenied(true);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.devMode, auth.loggedIn, auth.credential, params.slug, params.id, router]);

  const gate = authGate(auth, `/${params.slug}/sessions/${params.id}`);
  if (gate) return gate;

  if (denied) return <AccessErrorScreen />;

  return (
    <Screen className="px-4 py-3">
      <p className="px-1 py-3 text-[13px] text-sanba-muted">確認しています…</p>
    </Screen>
  );
}
