"use client";

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
