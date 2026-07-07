"use client";

// 過去の要件一覧（/results）。サイドメニュー「過去の要件一覧」の遷移先（要望 2026-07）。
// 以前はホームに置いていた「過去の要件を見る」履歴リストを専用画面へ移した。
// 本人限定 API（GET /api/sessions/mine）から供給し、各行は絵巻閲覧（/results/[id]）へ遷移する。
// 未ログイン・0 件・取得失敗はいずれも空状態の文言に落とす（本流を止めない）。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AccountMenu } from "@/components/AccountMenu";
import { AppShell } from "@/components/AppShell";
import { authGate } from "@/components/RequireAuth";
import { SessionHistoryList, type SessionHistoryItem } from "@/components/sanba";
import { fetchMySessions } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// ISO 8601 の作成時刻を一覧表示用の日付（YYYY/MM/DD）へ整形する。
// パースできない値は空文字にし、行は出すが日付欄は空にする（壊れた値で落とさない）。
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

  // 本人のセッション履歴を取得する。ログイン済みのときだけ叩き、失敗時は空状態を維持する。
  // idToken が変わったら取り直す。遅延解決は cancelled で握りつぶす。
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

  // 厳密な認証ゲート（全画面保護）。未ログインは /login?next=/results へ戻す。
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
