"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { Button, Chip } from "@/components/sanba";
import { AccountMenu } from "@/components/AccountMenu";
import { AppShell } from "@/components/AppShell";
import { RequirementsScrollList } from "@/components/RequirementsScrollList";
import { authGate } from "@/components/RequireAuth";
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
    if (!auth.devMode && !auth.loggedIn) return;
    try {
      setLoad({ state: "loading" });
      const data = await fetchMySessionRequirements(sessionId, auth.credential);
      setLoad({ state: "ok", data });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLoad({ state: "notfound" });
      else if (e instanceof ApiError && e.status === 401) setLoad({ state: "unauthenticated" });
      else setLoad({ state: "error" });
    }
  }, [auth.devMode, auth.loggedIn, auth.credential, sessionId]);

  useEffect(() => {
    void fetchScroll();
  }, [fetchScroll]);

  const gate = authGate(auth, `/results/${sessionId}`);
  if (gate) return gate;

  return (
    <AppShell
      current="results"
      title="要件絵巻"
      onBack={() => router.push("/results")}
      headerRight={<AccountMenu profile={auth.profile} />}
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 pb-10 pt-3">
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
      </div>
    </AppShell>
  );
}
