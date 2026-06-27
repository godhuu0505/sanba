"use client";

// 入口フロー（01 ホーム → 02 準備）。Issue #140 / Figma 正本 40:2・40:19。
// ADR-0017（一本道・Figma 正本準拠）に従い、価値訴求のホームと準備フォームを
// 別ビューに分離する。タブ式ナビは持たず、戻る ‹ のみの一本道で進む。
// 準備が整い接続すると 03 以降（SessionView）へ引き渡す（中身は #141 が担当）。
//
// 認証は /login へ寄せる（#140）。本ページはログイン状態を「開始ゲート」としてのみ参照し、
// 未ログインなら理由提示＋/login への導線を出す（インラインのログインパネルは廃止）。

import Link from "next/link";
import { useState } from "react";

import {
  AppHeader,
  Button,
  Card,
  Chip,
  Field,
  Screen,
  Textarea,
} from "@/components/sanba";
import {
  addSessionContext,
  createSession,
  joinSession,
  type JoinResponse,
} from "../lib/api";
import { useGoogleAuth } from "../lib/auth";
import { ConversationStart } from "../components/ConversationStart";
import { authGate } from "../components/RequireAuth";

// 役割チップ。表示は日本語、value は API（POST /api/sessions の roles）に渡す既存値。
// 既定は「企画(PdM)」= pm（02-prepare.md / #140）。
const ROLES = [
  { value: "pm", label: "企画(PdM)" },
  { value: "engineer", label: "エンジニア" },
  { value: "customer", label: "顧客" },
] as const;

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

type Step = "home" | "prepare";

export default function Home() {
  const [step, setStep] = useState<Step>("home");
  const [role, setRole] = useState<string>("pm");
  const [goal, setGoal] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = useGoogleAuth();

  // 厳密な認証ゲート（全画面保護 / docs/design/figma-implementation-audit.md A節）。
  // 未ログインは /login?next= へ戻す。判定は authGate に集約（解決前・dev の扱いも含む）。
  const gate = authGate(auth, "/");
  if (gate) return gate;

  async function handleStart() {
    if (busy) return; // 二重送信防止（#140 AC）。
    try {
      setBusy(true);
      setError(null);
      // 同意ゲート後にセッションを作成（issue #10）。createSession → join で
      // 「join 済みトークン」を得てから、ゴール文を文脈として投稿する（契約 §4）。
      // 本人確認は Google ログイン（ADR-0012）。
      const session = await createSession([role], consent, auth.credential);
      const invite = session.invites[role];
      const joined = await joinSession({
        invite,
        participantName: auth.profile?.name || "ゲスト",
        idToken: auth.credential,
      });
      if (goal.trim()) {
        // ゴールは RAG・会話初期文脈へ取り込む（source_name=goal / 02-prepare.md AC）。
        await addSessionContext(joined.session_id, goal, joined.session_token, "goal");
      }
      setConn(joined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── 03 会話開始: 開始前サマリ → 接続/許可 →（成功）04 会話履歴。失敗時は復帰導線。
  // 接続・マイク許可・失敗系は ConversationStart が所有する（screens/03 / ADR-0018）。
  if (conn) {
    const roleLabel = ROLES.find((r) => r.value === role)?.label ?? role;
    return (
      <ConversationStart
        conn={conn}
        goal={goal}
        roleLabel={roleLabel}
        // 中断したら会話を畳んで準備（02）へ戻す（マイク送信は SessionView 側で停止済み）。
        onCancel={() => setConn(null)}
      />
    );
  }

  // ── 02 準備 ───────────────────────────────────────────────────────────
  if (step === "prepare") {
    const canStart = consent && auth.loggedIn && !busy;
    return (
      <Screen className="px-4 py-3">
        <AppHeader title="セッション準備" onBack={() => setStep("home")} />
        <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
          <Field label="ゴール" htmlFor="goal" hint="例: 検索機能のリニューアル要件を固めたい">
            <Textarea
              id="goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="タップしてテーマを入力…"
            />
          </Field>

          <div className="flex flex-col gap-[8px]">
            <span className="text-[13px] font-bold text-[var(--sanba-muted)]">あなたの役割</span>
            <div role="radiogroup" aria-label="あなたの役割" className="flex flex-wrap gap-[8px]">
              {ROLES.map((r) => {
                const selected = role === r.value;
                return (
                  <Chip key={r.value} asChild tone="gold" size="md" solid={selected}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setRole(r.value)}
                    >
                      {selected && <span aria-hidden="true">● </span>}
                      {r.label}
                    </button>
                  </Chip>
                );
              })}
            </div>
          </div>

          {/* 同意ゲート（issue #10）。保持日数・PII マスク文言を併記。 */}
          <label className="flex items-start gap-[10px] text-[13px] leading-relaxed text-[var(--sanba-cream)]">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-[3px] size-[16px] accent-[var(--sanba-gold)]"
            />
            <span>
              録音と AI 処理に同意します（最大 {RETENTION_DAYS} 日保持・保存前に個人情報をマスク）。
            </span>
          </label>

          <div className="mt-1 flex flex-col gap-[8px]">
            <Button
              variant="gold"
              size="lg"
              block
              onClick={handleStart}
              disabled={!canStart}
              aria-label="インタビューを始める"
            >
              {busy ? "準備しています…" : "🎙️ インタビューを始める"}
            </Button>
            {!auth.loggedIn && (
              <p className="text-[12px] text-[var(--sanba-muted)]">
                開始するには本人確認が必要です。
                <Link href="/login" className="ml-1 text-[var(--sanba-gold-text)] underline">
                  ログインへ
                </Link>
              </p>
            )}
            {auth.loggedIn && !consent && (
              <p className="text-[12px] text-[var(--sanba-muted)]">
                録音と AI 処理への同意が必要です。
              </p>
            )}
            {error && <p className="text-[12px] text-[var(--sanba-rec)]">{error}</p>}
          </div>
        </main>
      </Screen>
    );
  }

  // ── 01 ホーム ─────────────────────────────────────────────────────────
  // Figma 正本（40:2）に実績カードは無い（#140/#147）。ヒーロー＋一語 CTA のみ。
  return (
    <Screen className="px-4 py-3">
      <AppHeader brand />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col pt-3">
        <Card>
          <h1 className="text-[22px] font-bold leading-snug text-[var(--sanba-gold-text)]">
            会議の前に、五分の問答を
          </h1>
          <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
            一問ずつ問いかけ、抜けと矛盾をその場で取り上げます。
          </p>
          <Button variant="gold" size="lg" block onClick={() => setStep("prepare")}>
            ＋ 壁打ちを始める
          </Button>
        </Card>
      </main>
    </Screen>
  );
}
