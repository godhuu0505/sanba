"use client";

// 過去要件の絵巻閲覧画面（/results/[id] / ADR-0040 で /sessions/[id] から移設。旧 URL は
// リダイレクトで互換維持）。ホーム「過去の要件を見る」（#215/#250）の行をタップした先で、
// そのセッションの要件絵巻と結果ドキュメント出力（ADR-0042/0043）を閲覧する。
// データ源は本人限定 API（GET /api/sessions/mine/{id}/requirements）。認証は Google idToken
// （ADR-0012）で、非所有・不存在は API が 404 に平すため、ここでは「見つからない」表示に落とす。
// 絵巻本体の見た目は会話中の 06 要件絵巻タブと共有する（RequirementsScrollList）。

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { AppHeader, Button, Chip, Screen } from "@/components/sanba";
import { RequirementsScrollList } from "@/components/RequirementsScrollList";
import { authGate } from "@/components/RequireAuth";
import { SideMenu } from "@/components/SideMenu";
import {
  ApiError,
  fetchMySessionRequirements,
  fetchMySessionResultDocument,
  type Audience,
  type MySessionRequirements,
  type ResultDocument,
} from "@/lib/api";
import { AUDIENCE_LABELS, AUDIENCES } from "@/lib/audience";
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

type DocLoad =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: ResultDocument }
  | { state: "error" };

export default function PastRequirementsPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [load, setLoad] = useState<Load>({ state: "loading" });
  // 結果ドキュメントの出力（audience 別フォーマット）。タブを押したときだけ取得する。
  const [audience, setAudience] = useState<Audience>("developer");
  const [doc, setDoc] = useState<DocLoad>({ state: "idle" });
  const [copied, setCopied] = useState(false);

  const fetchDocument = useCallback(
    async (target: Audience) => {
      setAudience(target);
      setCopied(false);
      setDoc({ state: "loading" });
      try {
        const data = await fetchMySessionResultDocument(sessionId, target, auth.credential);
        setDoc({ state: "ok", data });
      } catch {
        setDoc({ state: "error" });
      }
    },
    [sessionId, auth.credential],
  );

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
  const gate = authGate(auth, `/results/${sessionId}`);
  if (gate) return gate;

  return (
    <Screen className="sanba-scroll">
      <AppHeader back onBack={() => router.push("/")} title="要件絵巻" right={<SideMenu />} />
      <main className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 pb-10 pt-1">
        {load.state === "loading" && (
          <p className="px-1 py-3 text-[13px] text-sanba-muted">読み込み中…</p>
        )}

        {load.state === "notfound" && (
          <p className="px-1 py-3 text-[13px] leading-relaxed text-sanba-muted">
            この要件は見つかりませんでした。ご本人のセッションのみ閲覧できます。
          </p>
        )}

        {load.state === "unauthenticated" && (
          <div className="flex flex-col gap-3 px-1 py-3">
            <p className="text-[13px] leading-relaxed text-sanba-muted">
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
            <p className="text-[13px] text-sanba-muted">読み込みに失敗しました。</p>
            <Button variant="gold" block onClick={() => void fetchScroll()}>
              再び試みる
            </Button>
          </div>
        )}

        {load.state === "ok" && (
          <>
            <div className="flex flex-col gap-[2px] px-1">
              <h2 className="text-[18px] font-bold text-sanba-cream">
                {load.data.title}
              </h2>
              <p className="text-[12px] text-sanba-muted">
                {formatSessionDate(load.data.created_at)}
                {load.data.finalized ? " ・ 確定済み" : " ・ 未確定"}
              </p>
            </div>
            <RequirementsScrollList
              requirements={load.data.items}
              emptyText="このセッションの要件はまだ生まれておりませぬ。"
            />

            {/* 結果ドキュメントの出力: 読み手（利用者/企画者/開発者）別のフォーマットで整形。
                フォーマットはアプリ管理画面で登録でき、未登録はデフォルトが使われる。 */}
            <div className="flex flex-col gap-[8px] px-1 pt-2">
              <h3 className="text-[14px] font-bold text-sanba-cream">結果ドキュメントを出力</h3>
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                読み手に合わせたフォーマットで要件結果を文書化します。フォーマットは
                アプリ管理画面で登録でき、未登録の場合はデフォルトが使われます。
              </p>
              <div className="flex flex-wrap gap-[8px]" role="tablist" aria-label="出力の対象">
                {AUDIENCES.map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="tab"
                    aria-selected={doc.state !== "idle" && audience === a}
                    onClick={() => void fetchDocument(a)}
                  >
                    <Chip
                      tone={doc.state !== "idle" && audience === a ? "gold" : "neutral"}
                      size="md"
                    >
                      {AUDIENCE_LABELS[a]}向け
                    </Chip>
                  </button>
                ))}
              </div>
              {doc.state === "loading" && (
                <p className="text-[12px] text-sanba-muted">整形中…</p>
              )}
              {doc.state === "error" && (
                <p role="alert" className="text-[12px] text-sanba-rec-text">
                  ドキュメントの生成に失敗しました。もう一度お試しください。
                </p>
              )}
              {doc.state === "ok" && (
                <>
                  {!doc.data.is_custom_format && (
                    <p className="text-[11px] text-sanba-muted">
                      デフォルトのフォーマットで出力しています（アプリ管理画面で登録できます）。
                    </p>
                  )}
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px] text-[12px] leading-relaxed text-sanba-cream">
                    {doc.data.markdown}
                  </pre>
                  <Button
                    variant="outline"
                    block
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(doc.data.markdown)
                        .then(() => setCopied(true))
                        .catch(() => setCopied(false));
                    }}
                  >
                    {copied ? "コピーしました" : "Markdown をコピー"}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </main>
    </Screen>
  );
}
