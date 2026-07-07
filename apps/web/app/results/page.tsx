"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AccountMenu } from "@/components/AccountMenu";
import { AppShell } from "@/components/AppShell";
import { authGate } from "@/components/RequireAuth";
import { SessionHistoryList, type SessionHistoryItem } from "@/components/sanba";
import { fetchMySessions } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

export default function ResultsListPage() {
  const auth = useAuth();
  const router = useRouter();
  const [history, setHistory] = useState<SessionHistoryItem[]>([]);

  useEffect(() => {
    if (!auth.loggedIn) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    fetchMySessions(auth.credential)
      .then((sessions) => {
        if (cancelled) return;
        setHistory(
          sessions.map((s) => ({
            id: s.id,
            title: s.title,
            date: formatSessionDate(s.created_at),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.loggedIn, auth.credential]);

  const gate = authGate(auth, "/results");
  if (gate) return gate;

  return (
    <AppShell
      current="results"
      title="過去の要件一覧"
      headerRight={<AccountMenu profile={auth.profile} />}
    >
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-[18px] px-4 py-4">
        <SessionHistoryList items={history} />
      </div>
    </AppShell>
  );
}
