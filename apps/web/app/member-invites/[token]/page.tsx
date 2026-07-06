"use client";

// メンバー招待の承諾ページ（ADR-0036 決定2）。招待メールの URL
// /member-invites/{token} を開いた人が、内容を確認して承諾/辞退する。
// 承諾できるのは宛先メールアドレスの本人だけ（email_match）。ログインが必要なので
// 未ログインは /login?next= へ誘導し、戻ってきたら自動で内容を解決する。
// 深掘りリンク（/join）と違い、表示時の resolve は何も消費しない（安全に再読み込みできる）。

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { authGate } from "@/components/RequireAuth";
import { AppHeader, Button, Card, CardTitle, Screen } from "@/components/sanba";
import {
  ApiError,
  type MemberInviteResolution,
  resolveMemberInvite,
  respondMemberInviteByToken,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** 承諾できない状態の説明文（利用者向け・技術用語なし）。 */
const STATUS_MESSAGE: Record<string, string> = {
  accepted: "この招待は承諾済みです。アプリ一覧からご利用いただけます。",
  declined: "この招待は辞退済みです。参加するには新しい招待を依頼してください。",
  revoked: "この招待は取り消されています。招待した人に新しい招待を依頼してください。",
  expired: "この招待は有効期限を過ぎています。招待した人に新しい招待を依頼してください。",
};

export default function MemberInvitePage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = decodeURIComponent(params.token);

  const [resolved, setResolved] = useState<MemberInviteResolution | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canFetch = auth.devMode || auth.loggedIn;
  const credential = auth.credential;

  // 表示時にトークンを解決して確認情報を出す（消費は伴わないためリロードしても安全）。
  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    resolveMemberInvite(token, credential)
      .then((r) => !cancelled && setResolved(r))
      .catch(() => !cancelled && setInvalid(true));
    return () => {
      cancelled = true;
    };
  }, [canFetch, token, credential]);

  // 未ログインは /login へ（戻り先はこのページ）。
  const gate = authGate(auth, `/member-invites/${encodeURIComponent(params.token)}`);
  if (gate) return gate;

  async function handleRespond(action: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const res = await respondMemberInviteByToken(token, action, credential);
      setDone(action === "accept" ? "accepted" : "declined");
      if (action === "accept") {
        router.push(`/products/${encodeURIComponent(res.product_id)}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("この招待は既に応答済みか、取り消し・期限切れになっています");
      } else if (e instanceof ApiError && e.status === 403) {
        setError("この招待は別のメールアドレス宛です。宛先のアカウントでログインし直してください");
      } else {
        setError("応答できませんでした。時間をおいて再度お試しください");
      }
      setBusy(false);
    }
  }

  const pending = resolved?.status === "pending";

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader title="メンバー招待" onBack={() => router.push("/")} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {invalid ? (
          <Card>
            <CardTitle>招待リンクが無効です</CardTitle>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              このリンクは正しくないか、招待が削除されています。
              招待した人に新しい招待を依頼してください。
            </p>
            <Button variant="outline" block onClick={() => router.push("/")}>
              ホームへ戻る
            </Button>
          </Card>
        ) : resolved === null ? (
          <Card>
            <p className="text-[12px] text-sanba-muted">招待の内容を確認しています…</p>
          </Card>
        ) : done === "declined" ? (
          <Card>
            <CardTitle>辞退しました</CardTitle>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              「{resolved.product_name}」への招待を辞退しました。
            </p>
            <Button variant="outline" block onClick={() => router.push("/")}>
              ホームへ戻る
            </Button>
          </Card>
        ) : (
          <Card>
            <CardTitle>「{resolved.product_name}」に招待されています</CardTitle>
            <p className="text-[13px] leading-relaxed text-sanba-cream">
              {resolved.invited_by_email} さんから、このアプリで要件サンバ
              （音声での要件深掘り）をするメンバーに招待されています。
            </p>
            {!pending ? (
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                {STATUS_MESSAGE[resolved.status] ?? "この招待には応答できません。"}
              </p>
            ) : !resolved.email_match ? (
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                この招待は {resolved.masked_email} 宛です。宛先のアカウントで
                ログインし直すと承諾できます。
              </p>
            ) : (
              <div className="flex flex-col gap-[8px]">
                <Button
                  variant="gold"
                  size="lg"
                  block
                  disabled={busy}
                  onClick={() => handleRespond("accept")}
                >
                  {busy ? "処理しています…" : "招待を承諾する"}
                </Button>
                <Button
                  variant="outline"
                  block
                  disabled={busy}
                  onClick={() => handleRespond("decline")}
                >
                  辞退する
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-[12px] text-sanba-rec-text">
                {error}
              </p>
            )}
          </Card>
        )}
      </main>
    </Screen>
  );
}
