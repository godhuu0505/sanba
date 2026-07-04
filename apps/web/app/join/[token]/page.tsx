"use client";

// 深掘りリンク入場画面（ADR-0031 決定3 / FR-1.6）。
// 開発者が発行した /join/{token} を開いた人が、同意 → 開始の 2 タップで
// product 従属セッションの会話に入る。02 準備は出さない（ゴール・repo は
// product から継承済み / PR3）。
//
// 重要: POST /api/products/join は呼ぶたびにリンクの use_count を消費する。
// ページ表示・リロード・自動リトライでは呼ばず、「開始する」タップの 1 回だけ呼ぶ。
// Stage 1 はログイン必須（authGate）。ゲスト入場は ADR-0032（Stage 2）。

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { ConversationStart } from "@/components/ConversationStart";
import { authGate } from "@/components/RequireAuth";
import { AppHeader, Button, Card, CardTitle, Screen } from "@/components/sanba";
import { ApiError, joinProduct, joinSession, type JoinResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";

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
}

/**
 * ApiError → 入場エラー画面の出し分け（PR3 の応答仕様）。
 * 403 の detail は "invite not usable: expired|revoked|exhausted" または
 * "invalid invite link: ..."。404 はリンク/アプリの消滅、429 はレート制限。
 */
export function classifyJoinError(e: unknown): JoinError {
  if (e instanceof ApiError) {
    if (e.status === 403) {
      if (e.message.includes("expired")) {
        return {
          title: "リンクの期限が切れています",
          description: "この深掘りリンクは有効期限を過ぎています。発行者に新しいリンクを依頼してください。",
          retryable: false,
        };
      }
      if (e.message.includes("revoked")) {
        return {
          title: "リンクは無効化されています",
          description: "この深掘りリンクは発行者によって失効されました。発行者に新しいリンクを依頼してください。",
          retryable: false,
        };
      }
      if (e.message.includes("exhausted")) {
        return {
          title: "リンクの利用上限に達しています",
          description: "この深掘りリンクは使用回数の上限に達しました。発行者に新しいリンクを依頼してください。",
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
        description: "この深掘りリンクは存在しないか、対象のアプリが削除された可能性があります。",
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
        description: "録音と AI 処理への同意にチェックを入れてから開始してください。",
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

  // Stage 1 はログイン必須。未ログインは /login?next=/join/{token} → ログイン後に復帰。
  const gate = authGate(auth, `/join/${encodeURIComponent(token)}`);
  if (gate) return gate;

  async function handleStart() {
    if (busy) return; // 二重送信防止（use_count を無駄に消費しない）。
    if (!consent) {
      setError(classifyJoinError(new ApiError(400, "consent required")));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 消費を伴う join はここ 1 回だけ。失敗しても自動では再送しない。
      const joined = await joinProduct(token, consent, auth.credential);
      const session = await joinSession({
        invite: joined.invite,
        participantName: auth.profile?.name || "ゲスト",
        idToken: auth.credential,
      });
      setProductName(joined.product_name);
      setRoleLabel(MODE_ROLE_LABEL[joined.interview_mode] ?? joined.interview_mode);
      setConn(session);
    } catch (e) {
      setError(classifyJoinError(e));
    } finally {
      setBusy(false);
    }
  }

  // 接続・マイク許可・失敗系は ConversationStart が所有する（app/page.tsx と同じ流儀）。
  // 中断はホームへ（準備画面は無いリンク入場のため、戻る先は 01 ホーム）。
  if (conn) {
    return (
      <ConversationStart
        conn={conn}
        goal={productName ? `「${productName}」の深掘り` : ""}
        roleLabel={roleLabel}
        onCancel={() => router.push("/")}
      />
    );
  }

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader title="深掘りに参加" onBack={() => router.push("/")} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {error && !error.retryable ? (
          // リンクが死んでいる（期限切れ・失効・上限・不正・消滅）: 開始 UI は出さない。
          <Card>
            <CardTitle>{error.title}</CardTitle>
            <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
              {error.description}
            </p>
            <Button variant="outline" block onClick={() => router.push("/")}>
              ホームへ戻る
            </Button>
          </Card>
        ) : (
          <Card>
            <CardTitle>深掘りリンクから参加します</CardTitle>
            <p className="text-[13px] leading-relaxed text-[var(--sanba-cream)]">
              このリンクの発行者が対象のアプリを準備済みです。開始すると、音声で一問ずつ
              問いかける深掘りセッションが始まります（準備の入力は不要です）。
            </p>
            {/* 同意ゲート（issue #10）。02 準備と同じ文言・保持日数を明示する。 */}
            <label className="flex items-start gap-[10px] text-[13px] leading-relaxed text-[var(--sanba-cream)]">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-[3px] size-[16px] accent-[var(--sanba-gold)]"
              />
              <span>
                録音と AI 処理に同意します（最大 {RETENTION_DAYS}{" "}
                日保持・保存前に個人情報をマスク）。
              </span>
            </label>
            {error && (
              <p role="alert" className="text-[12px] text-[var(--sanba-rec-text)]">
                {error.title} — {error.description}
              </p>
            )}
            <Button
              variant="gold"
              size="lg"
              block
              disabled={busy || !consent}
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
