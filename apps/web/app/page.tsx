"use client";

// 入口フロー（01 ホーム → 02 準備）。Issue #140 / Figma 正本 40:2・40:19。
// ADR-0017（一本道・Figma 正本準拠）に従い、価値訴求のホームと準備フォームを
// 別ビューに分離する。タブ式ナビは持たず、戻る ‹ のみの一本道で進む。
// 準備が整い接続すると 03 以降（SessionView）へ引き渡す（中身は #141 が担当）。
//
// 認証は /login へ寄せる（#140）。本ページはログイン状態を「開始ゲート」としてのみ参照し、
// 未ログインなら理由提示＋/login への導線を出す（インラインのログインパネルは廃止）。

import Link from "next/link";
import { useRef, useState } from "react";

import {
  AppHeader,
  Button,
  Card,
  Chip,
  Field,
  Screen,
  SessionHistoryList,
  Textarea,
} from "@/components/sanba";
import {
  ACCEPTED_IMAGE,
  ACCEPTED_VIDEO,
  addSessionContext,
  classifyUpload,
  createSession,
  joinSession,
  uploadContextFile,
  type JoinResponse,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { AccountMenu } from "../components/AccountMenu";
import { ConversationStart } from "../components/ConversationStart";
import {
  MaterialSourceSheet,
  type MaterialSource,
} from "../components/MaterialSourceSheet";
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
  // 参考資料（バイナリ添付）。join 前アップロード経路が無い（ADR-0017 一本道）ため、
  // 選んだファイルはクライアント側でステージし、handleStart の join 直後に順次投入する。
  const [staged, setStaged] = useState<File[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const auth = useAuth();

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
      // 準備画面でステージした参考資料を、会話開始前に join 済みトークンで順次投入する
      // （契約 §4 / ADR-0017 一本道。join 前 upload 経路が無いためここで一括投入）。
      // 1 件の失敗で開始全体は止めない（成功分は 05 で復元・失敗分は会話中に再投入できる）。
      for (const file of staged) {
        try {
          await uploadContextFile(joined.session_id, file, joined.session_token);
        } catch (uploadErr) {
          // 投入失敗は観測できるようログに残す（収集先の OTLP/メトリクス配線は #232）。
          console.error("staged material upload failed", file.name, uploadErr);
        }
      }
      setConn(joined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── 参考資料（バイナリ添付）の操作 ────────────────────────────────────────
  // 投入種別の計測 seam（CLAUDE.md 原則3）。準備画面はカメラ/画面共有を出さないため
  // upload/drive のみが流れる。収集先（OTLP/メトリクス基盤）への配線は #232。
  function measureSource(source: MaterialSource) {
    void source;
  }

  // ピッカで選んだファイルをステージする。非対応形式は弾いて理由を出す
  // （API と同じ受理範囲: PNG/JPG・MP4/MOV / 要件票 06）。
  function handleAddFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 同じファイルの再選択でも change を発火させる。
    if (files.length === 0) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (classifyUpload(f.name)) accepted.push(f);
      else rejected.push(f.name);
    }
    if (accepted.length > 0) {
      // 同名・同サイズの重複はステージしない（取り違え・二重投入の防止）。
      setStaged((prev) => {
        const key = (f: File) => `${f.name}:${f.size}`;
        const seen = new Set(prev.map(key));
        return [...prev, ...accepted.filter((f) => !seen.has(key(f)))];
      });
    }
    setAttachError(
      rejected.length > 0
        ? `対応していない形式です（PNG/JPG・MP4/MOV）: ${rejected.join("、")}`
        : null,
    );
  }

  function removeStaged(index: number) {
    setStaged((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
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
        // 03-0 開始前サマリの「参考資料」に添付名/件数を反映する（監査 B-2 #11）。
        materialNames={staged.map((f) => f.name)}
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
          {/* フィールド順は Figma 正本に合わせて 役割 → ゴール（02-prepare）。 */}
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

          <Field label="ゴール" htmlFor="goal" hint="例: 検索機能のリニューアル要件を固めたい">
            <Textarea
              id="goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="タップしてテーマを入力…"
            />
          </Field>

          {/* 参考資料（バイナリ添付）。Figma 89:25 / 91:10。押下で手段選択シート（#201 再利用）を開く。
              準備画面は LiveKit ルーム外のためカメラ/画面共有は渡さず、アップロード/Drive のみ。
              選んだファイルはステージ（チップ表示・削除可）し、handleStart で会話開始前に投入する。 */}
          <div className="flex flex-col gap-[8px]">
            <span className="text-[13px] font-bold text-[var(--sanba-muted)]">
              参考資料（任意）
            </span>
            <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
              モック・スクショ・写真（PNG/JPG）や録画（MP4/MOV）を、会話の前に渡しておけます。
            </p>

            {staged.length > 0 && (
              <ul aria-label="添付した参考資料" className="flex flex-wrap gap-[8px]">
                {staged.map((file, i) => (
                  <li key={`${file.name}:${file.size}`}>
                    <Chip tone="gold" size="md">
                      <span aria-hidden="true">📄 </span>
                      <span className="max-w-[180px] truncate align-middle">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeStaged(i)}
                        aria-label={`${file.name} を取り外す`}
                        className="ml-[6px] text-[var(--sanba-muted)]"
                      >
                        ✕
                      </button>
                    </Chip>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={() => {
                setAttachError(null);
                setSheetOpen(true);
              }}
              aria-haspopup="dialog"
              className="rounded-[12px] border border-dashed border-[var(--sanba-frame)] bg-[#1b140b] px-3 py-[13px] text-left text-[12.5px] font-bold text-[var(--sanba-gold-text)]"
            >
              ＋ ファイルを追加
            </button>

            {attachError && (
              <p role="alert" className="text-[12px] text-[var(--sanba-rec)]">
                {attachError}
              </p>
            )}
          </div>

          {/* 隠しファイルピッカ。受理範囲は API と同一（PNG/JPG・MP4/MOV）。複数選択可。 */}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={`${ACCEPTED_IMAGE},${ACCEPTED_VIDEO}`}
            onChange={handleAddFiles}
            className="hidden"
          />

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

        {/* 資料の追加方法シート（#201 再利用）。準備画面は LiveKit ルーム外のため
            カメラ/画面共有ハンドラは渡さない＝アップロード/Drive のみ。Drive は ADR-0007 未承認で
            シート側が「準備中」を案内する。投入種別は onSelectSource で計測可能にする（#232 へ配線）。 */}
        {sheetOpen && (
          <MaterialSourceSheet
            onClose={() => setSheetOpen(false)}
            onUpload={() => {
              setSheetOpen(false);
              fileInput.current?.click();
            }}
            onSelectSource={measureSource}
          />
        )}
      </Screen>
    );
  }

  // ── 01 ホーム ─────────────────────────────────────────────────────────
  // Figma 正本（40:2）に *実績(stat)カード* は無い（#140/#147）。ヒーロー＋一語 CTA に加え、
  // 正本 99:3「過去の要件を見る」履歴リスト（stat カードとは別物）を下に置く（#215）。
  // 履歴データ取得 API は別途のため、現状は空状態の文言を出す（props で受け取り可能）。
  return (
    <Screen className="px-4 py-3">
      <AppHeader brand right={<AccountMenu profile={auth.profile} />} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-3">

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
        <SessionHistoryList items={[]} />
      </main>
    </Screen>
  );
}
