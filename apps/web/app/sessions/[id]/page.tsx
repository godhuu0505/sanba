"use client";

// 過去要件の絵巻閲覧画面（/sessions/[id]）。ホーム「過去の要件を見る」（#215/#250）の行を
// タップした先で、そのセッションの要件絵巻**だけ**を閲覧する（会話履歴・資料タブは持たない）。
// データ源は本人限定 API（GET /api/sessions/mine/{id}/requirements）。認証は Google idToken
// （ADR-0012）で、非所有・不存在は API が 404 に平すため、ここでは「見つからない」表示に落とす。
// 絵巻本体の見た目は会話中の 06 要件絵巻タブと共有する（RequirementsScrollList）。

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { AppHeader, Button, Screen } from "@/components/sanba";
import { RequirementsScrollList } from "@/components/RequirementsScrollList";
import { authGate } from "@/components/RequireAuth";
import { ApiError, fetchMySessionRequirements, type MySessionRequirements } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// ISO 8601 を表示用の日付（YYYY/MM/DD）へ整形する（ホームの履歴リストと同じ表記）。
// パースできない値は空文字にする（壊れた値で落とさない）。
function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

type Load =
  | { state: "loading" }
  | { state: "ok"; data: MySessionRequirements }
  | { state: "notfound" }
  | { state: "unauthenticated" }
  | { state: "error" };

export default function PastRequirementsPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [load, setLoad] = useState<Load>({ state: "loading" });

  const fetchScroll = useCallback(async () => {
    // dev モードは idToken=null のまま API の AUTH_DEV_BYPASS に委ねる（admin と同じ扱い）。
    if (!auth.devMode && !auth.loggedIn) return;
    try {
      setLoad({ state: "loading" });
      const data = await fetchMySessionRequirements(sessionId, auth.credential);
      setLoad({ state: "ok", data });
    } catch (e) {
      // 404 = 非所有 or 不存在（API が同じ応答に平す）。401 = idToken 期限切れ/失効で、
      // authGate はメモリ上の loggedIn しか見ないため到達する（再認証導線へ / Codex P2）。
      // それ以外は再試行導線つきの失敗表示。
      if (e instanceof ApiError && e.status === 404) setLoad({ state: "notfound" });
      else if (e instanceof ApiError && e.status === 401) setLoad({ state: "unauthenticated" });
      else setLoad({ state: "error" });
    }
  }, [auth.devMode, auth.loggedIn, auth.credential, sessionId]);

  useEffect(() => {
    void fetchScroll();
  }, [fetchScroll]);

  // 厳密な認証ゲート（全画面保護）。未ログインは /login?next= へ戻し、ログイン後にここへ復帰する。
  const gate = authGate(auth, `/sessions/${sessionId}`);
  if (gate) return gate;

  return (
    <Screen className="sanba-scroll">
      <AppHeader back onBack={() => router.push("/")} title="要件絵巻" />
      <main className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 pb-10 pt-1">
        {load.state === "loading" && (
          <p className="px-1 py-3 text-[13px] text-[var(--sanba-muted)]">読み込み中…</p>
        )}

        {load.state === "notfound" && (
          <p className="px-1 py-3 text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            この要件は見つかりませんでした。ご本人のセッションのみ閲覧できます。
          </p>
        )}

        {load.state === "unauthenticated" && (
          <div className="flex flex-col gap-3 px-1 py-3">
            <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
              ログインの期限が切れました。もう一度ログインしてください。
            </p>
            {/* 期限切れ credential が残ったままだと同じ無効トークンで再試行し続けるため、
                admin と同様に signOut で clear し、authGate 経由で /login?next= へ送る（Codex P2）。
                期限切れ回復であり明示ログアウトではないため、他タブへは伝播させない
                （broadcast:false / 別タブの進行中会話を巻き添えにしない / ADR-0030）。 */}
            <Button variant="gold" block onClick={() => auth.signOut({ broadcast: false })}>
              ログインへ
            </Button>
          </div>
        )}

        {load.state === "error" && (
          <div className="flex flex-col gap-3 px-1 py-3">
            <p className="text-[13px] text-[var(--sanba-muted)]">読み込みに失敗しました。</p>
            <Button variant="gold" block onClick={() => void fetchScroll()}>
              再び試みる
            </Button>
          </div>
        )}

        {load.state === "ok" && (
          <>
            <div className="flex flex-col gap-[2px] px-1">
              <h2 className="text-[18px] font-bold text-[var(--sanba-cream)]">
                {load.data.title}
              </h2>
              <p className="text-[12px] text-[var(--sanba-muted)]">
                {formatSessionDate(load.data.created_at)}
                {load.data.finalized ? " ・ 確定済み" : " ・ 未確定"}
              </p>
            </div>
            <RequirementsScrollList
              requirements={load.data.items}
              emptyText="このセッションの要件はまだ生まれておりませぬ。"
            />
          </>
        )}
      </main>
    </Screen>
  );
}
