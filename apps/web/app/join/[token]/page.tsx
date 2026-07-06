"use client";

// 深掘りリンク入場画面（ADR-0031 決定3 / ADR-0032 決定1 / FR-1.6 / FR-2.1）。
// 発行された /join/{token} を開いた人が、同意 → 開始の 2 タップで
// product 従属セッションの会話に入る。02 準備は出さない（ゴール・repo は
// product から継承済み / PR3）。
//
// Stage 2（ゲスト入場）: 未ログインでもログインへ飛ばさず、まず同意ゲートを
// 出す。同意後に Authorization 無しで joinProduct し、応答の join（LiveKit トークン +
// session_token）でそのまま接続する（joinSession は呼ばない）。ゲスト可否の判定は常に
// API が正（guest_join_enabled × scope=end_user）。401 のときだけログインへ誘導する。
//
// 重要: POST /api/products/join は呼ぶたびにリンクの use_count を消費する。
// ページ表示・リロード・自動リトライでは呼ばず、「開始する」タップの 1 回だけ呼ぶ。

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { ConversationStart } from "@/components/ConversationStart";
import { AppHeader, Button, Card, CardTitle, Screen } from "@/components/sanba";
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

/** interview_mode → 参加役割の表示名（api の _INVITE_ROLE 写像と対応）。 */
const MODE_ROLE_LABEL: Record<string, string> = {
  developer: "企画(PdM)",
  end_user: "顧客",
};

/** 入場エラーの表示情報。リンクが死んでいる（再試行しても無駄）かで導線を変える。 */
interface JoinError {
  title: string;
  description: string;
  /** true なら「再試行」を出す（429 など一時的な失敗のみ）。 */
  retryable: boolean;
  /** true ならログイン導線を出す（401 = ゲスト不可のリンク / FR-2.1）。 */
  loginRequired?: boolean;
}

/**
 * ApiError → 入場エラー画面の出し分け（PR3/PR6 の応答仕様）。
 * 403 の detail は "invite not usable: expired|revoked|exhausted" または
 * "invalid invite link: ..."。404 はリンク/アプリの消滅、429 はレート制限。
 * 401 はゲスト入場不可（guest_join_enabled off / developer リンク）= ログインへ誘導。
 * 文言は利用者向け（技術用語なし / FR-2.2）。
 */
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
  // URL の {token} セグメント。Next がデコード済みの値を返す（products/[id] と同じ流儀）。
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
  // ゲスト入場（join 直返し）だったか。会話画面を読取専用にする（ADR-0032 決定4）。
  const [isGuest, setIsGuest] = useState(false);
  // joinProduct の結果をキャッシュ: joinSession リトライ時に use_count を再消費しないため。
  const [pendingJoin, setPendingJoin] = useState<ProductJoinResult | null>(null);

  // 認証は解決を待つが、未ログインでもログインへ飛ばさない（Stage 2 / FR-2.1）。
  // ゲスト可否はサーバが判定する（401 なら classifyJoinError がログインへ誘導する）。
  // 解決前に開始させないのは、ログイン済みの人が GIS 復元前のタップでゲスト扱いに
  // なるのを防ぐため（use_count も無駄に消費しない）。
  const authSettling = !auth.devMode && !auth.ready;

  async function handleStart() {
    if (busy || authSettling) return; // 二重送信防止（use_count を無駄に消費しない）。
    if (!consent) {
      setError(classifyJoinError(new ApiError(400, "consent required")));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // joinProduct は use_count を消費する。成功結果をキャッシュし、
      // joinSession リトライ時に再消費しないようにする（max_uses=1 対策）。
      const joined = pendingJoin ?? (await joinProduct(token, consent, auth.credential));
      if (!pendingJoin) setPendingJoin(joined);
      // ゲスト入場（ADR-0032 決定1）: LiveKit トークン + session_token が直接返る。
      // sessions/join は呼ばない（require_user のまま）。
      // ログイン済み: 従来どおり役割 invite を joinSession で交換する。
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
        // 契約違反（invite も join も無い）。リンク不正と同じ扱いで発行者へ差し戻す。
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

  // 接続・マイク許可・失敗系は ConversationStart が所有する（app/page.tsx と同じ流儀）。
  // 中断はホームへ。離脱は join.abort として観測へ残す（列挙値のみ・PII なし / 原則3）。
  if (conn) {
    const leave = () => {
      sendTelemetry(conn.session_id, "join.abort", { result: "aborted" }, conn.session_token);
      router.push("/");
    };
    return (
      <InterviewModeProvider value={interviewMode}>
        <ConversationStart
          conn={conn}
          goal={productName ? `「${productName}」の深掘り` : ""}
          roleLabel={roleLabel}
          readOnly={isGuest}
          onCancel={leave}
        />
      </InterviewModeProvider>
    );
  }

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader title="深掘りに参加" onBack={() => router.push("/")} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {error && !error.retryable ? (
          // リンクが死んでいる（期限切れ・失効・上限・不正・消滅）またはログインが必要:
          // 開始 UI は出さない（再タップで use_count を再消費させない）。
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
            <CardTitle>リンクから会話に参加します</CardTitle>
            <p className="text-[13px] leading-relaxed text-sanba-cream">
              このリンクの発行者が、対象のアプリを準備済みです。開始すると、声で一問ずつ
              おたずねする会話が始まります（事前の入力は不要です）。
            </p>
            {/*
              同意ゲート（FR-2.2 / FR-2.7 / ADR-0032 決定4）。ゲストにも省略しない。
              技術用語を使わず、保持期間（30 日で自動削除）と「整理した内容は発行者に残る」
              ことを正直に明示する。チェックなしでは開始できない（API 側でも 400 で防ぐ）。
            */}
            <div className="rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px]">
              <p className="text-[12.5px] font-bold text-sanba-cream">はじめる前にご確認ください</p>
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
              aria-label="深掘りを開始する"
            >
              {busy ? "準備しています…" : "開始する"}
            </Button>
          </Card>
        )}
      </main>
    </Screen>
  );
}
