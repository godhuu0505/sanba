"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { ConversationStart } from "@/components/ConversationStart";
import { AppHeader, Button, Card, CardTitle, HelpIcon, Screen } from "@/components/sanba";
import {
  ApiError,
  joinProduct,
  joinSession,
  sendTelemetry,
  type JoinResponse,
  type ProductJoinResult,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { InterviewModeProvider, type InterviewMode } from "@/lib/interviewMode";

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

const MODE_ROLE_LABEL: Record<string, string> = {
  developer: "企画者",
  end_user: "利用者",
};

interface JoinError {
  title: string;
  description: string;
  retryable: boolean;
  loginRequired?: boolean;
}

export function classifyJoinError(e: unknown): JoinError {
  if (e instanceof ApiError) {
    if (e.status === 401) {
      return {
        title: "参加にはログインが必要です",
        description:
          "このリンクは、ログインした方だけが参加できる設定です。Google アカウントでログインしてから、もう一度お試しください。",
        retryable: false,
        loginRequired: true,
      };
    }
    if (e.status === 403) {
      if (e.message.includes("expired")) {
        return {
          title: "リンクの期限が切れています",
          description: "この参加リンクは有効期限を過ぎています。発行者に新しいリンクを依頼してください。",
          retryable: false,
        };
      }
      if (e.message.includes("revoked")) {
        return {
          title: "リンクは無効化されています",
          description: "この参加リンクは発行者によって停止されました。発行者に新しいリンクを依頼してください。",
          retryable: false,
        };
      }
      if (e.message.includes("exhausted")) {
        return {
          title: "リンクの利用上限に達しています",
          description: "この参加リンクは使える回数の上限に達しました。発行者に新しいリンクを依頼してください。",
          retryable: false,
        };
      }
      return {
        title: "リンクが正しくありません",
        description: "URL が途中で切れていないか確認し、発行者から届いたリンクをそのまま開いてください。",
        retryable: false,
      };
    }
    if (e.status === 404) {
      return {
        title: "リンクが見つかりません",
        description: "この参加リンクは存在しないか、対象のアプリが削除された可能性があります。",
        retryable: false,
      };
    }
    if (e.status === 429) {
      return {
        title: "混み合っています",
        description: "アクセスが集中しています。少し時間をおいて、もう一度お試しください。",
        retryable: true,
      };
    }
    if (e.status === 400) {
      return {
        title: "同意が必要です",
        description: "録音と AI による整理への同意にチェックを入れてから開始してください。",
        retryable: true,
      };
    }
  }
  return {
    title: "開始できませんでした",
    description: "通信に失敗しました。少し時間をおいて、もう一度お試しください。",
    retryable: true,
  };
}

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const auth = useAuth();
  const router = useRouter();

  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<JoinError | null>(null);
  const [conn, setConn] = useState<JoinResponse | null>(null);
  const [productName, setProductName] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("developer");
  const [isGuest, setIsGuest] = useState(false);
  const [pendingJoin, setPendingJoin] = useState<ProductJoinResult | null>(null);

  const authSettling = !auth.devMode && !auth.ready;

  async function handleStart() {
    if (busy || authSettling) return;
    if (!consent) {
      setError(classifyJoinError(new ApiError(400, "consent required")));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const joined = pendingJoin ?? (await joinProduct(token, consent, auth.credential));
      if (!pendingJoin) setPendingJoin(joined);
      let session: JoinResponse;
      if (joined.join) {
        session = joined.join;
      } else if (joined.invite) {
        session = await joinSession({
          invite: joined.invite,
          participantName: auth.profile?.name || "ゲスト",
          idToken: auth.credential,
        });
      } else {
        throw new ApiError(403, "invalid invite link: empty join response");
      }
      setProductName(joined.product_name);
      setRoleLabel(MODE_ROLE_LABEL[joined.interview_mode] ?? joined.interview_mode);
      setInterviewMode(joined.interview_mode === "end_user" ? "end_user" : "developer");
      setIsGuest(joined.join !== null);
      setConn(session);
    } catch (e) {
      setError(classifyJoinError(e));
    } finally {
      setBusy(false);
    }
  }

  if (conn) {
    const leave = () => {
      sendTelemetry(conn.session_id, "join.abort", { result: "aborted" }, conn.session_token);
      router.push("/");
    };
    return (
      <InterviewModeProvider value={interviewMode}>
        <ConversationStart
          conn={conn}
          goal={productName ? `「${productName}」の会話` : ""}
          roleLabel={roleLabel}
          readOnly={isGuest}
          onCancel={leave}
        />
      </InterviewModeProvider>
    );
  }

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader title="会話に参加" onBack={() => router.push("/")} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2 lg:max-w-[560px] lg:pt-6">
        {error && !error.retryable ? (
          <Card>
            <CardTitle>{error.title}</CardTitle>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              {error.description}
            </p>
            {error.loginRequired && (
              <Button
                variant="gold"
                block
                onClick={() => router.push(`/login?next=${encodeURIComponent(`/join/${token}`)}`)}
              >
                ログインして参加する
              </Button>
            )}
            <Button variant="outline" block onClick={() => router.push("/")}>
              ホームへ戻る
            </Button>
          </Card>
        ) : (
          <Card>
            <div className="flex items-center gap-[6px]">
              <CardTitle>リンクから会話に参加します</CardTitle>
              <HelpIcon term="会話リンク" />
            </div>
            <p className="text-[13px] leading-relaxed text-sanba-cream">
              このリンクの発行者が、対象のアプリを準備済みです。開始すると、声で一問ずつ
              おたずねする会話が始まります（事前の入力は不要です）。
            </p>
            <div className="rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px]">
              <p className="flex items-center gap-[4px] text-[12.5px] font-bold text-sanba-cream">
                はじめる前にご確認ください
                <HelpIcon term="録音とデータの扱い" />
              </p>
              <ul className="mt-[6px] list-disc space-y-[4px] pl-4 text-[12px] leading-relaxed text-sanba-muted">
                <li>この会話は録音され、内容の整理に AI を使います。</li>
                <li>録音と会話の記録は、{RETENTION_DAYS} 日たつと自動で削除されます。</li>
                <li>
                  会話から整理された困りごと・要望は、このアプリの発行者（作り手）に伝わり、
                  発行者の手元には残ります。
                </li>
                <li>お名前や連絡先などの個人情報は、保存する前に伏せ字にします。</li>
              </ul>
            </div>
            <label className="flex items-start gap-[10px] text-[13px] leading-relaxed text-sanba-cream">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-[3px] size-[16px] accent-sanba-gold"
              />
              <span>上記を確認し、録音と AI による整理に同意します。</span>
            </label>
            {error && (
              <p role="alert" className="text-[12px] text-sanba-rec-text">
                {error.title} — {error.description}
              </p>
            )}
            <Button
              variant="gold"
              size="lg"
              block
              disabled={busy || !consent || authSettling}
              onClick={handleStart}
              aria-label="会話を始める"
            >
              {busy ? "準備しています…" : "開始する"}
            </Button>
          </Card>
        )}
      </main>
    </Screen>
  );
}
