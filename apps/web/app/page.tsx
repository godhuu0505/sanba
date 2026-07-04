"use client";

// 入口フロー（01 ホーム → 02 準備）。Issue #140 / Figma 正本 40:2・40:19。
// ADR-0017（一本道・Figma 正本準拠）に従い、価値訴求のホームと準備フォームを
// 別ビューに分離する。タブ式ナビは持たず、戻る ‹ のみの一本道で進む。
// 準備が整い接続すると 03 以降（SessionView）へ引き渡す（中身は #141 が担当）。
//
// 認証は /login へ寄せる（#140）。本ページはログイン状態を「開始ゲート」としてのみ参照し、
// 未ログインなら理由提示＋/login への導線を出す（インラインのログインパネルは廃止）。

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  AppHeader,
  Button,
  Card,
  Chip,
  Field,
  Figure,
  Screen,
  SessionHistoryList,
  type SessionHistoryItem,
  Textarea,
} from "@/components/sanba";
import {
  ACCEPTED_IMAGE,
  ACCEPTED_VIDEO,
  addSessionContext,
  classifyUpload,
  createSession,
  fetchMySessions,
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
import { clearPrep, readPrep, writePrep } from "../lib/prepFormStorage";

// 役割チップ。表示は日本語、value は API（POST /api/sessions の roles）に渡す既存値。
// 既定は「企画(PdM)」= pm（02-prepare.md / #140）。
const ROLES = [
  { value: "pm", label: "企画(PdM)" },
  { value: "engineer", label: "エンジニア" },
  { value: "customer", label: "顧客" },
] as const;

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

// ISO 8601 の作成時刻を履歴リスト表示用の日付（YYYY/MM/DD）へ整形する（#250）。
// パースできない値は空文字にし、行は出すが日付欄は空にする（壊れた値で落とさない）。
function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

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
  // 開始時に「実際に投入できた」名前と失敗件数のスナップショット。03-0 サマリは
  // staged ではなくこれを参照し、未登録ファイルを「添付済み」と誤認させない（Codex P2）。
  const [uploadedNames, setUploadedNames] = useState<string[]>([]);
  const [uploadFailedCount, setUploadFailedCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  // ホーム「過去の要件を見る」履歴リスト（#215）の中身（#250）。取得できるまでは空 = 空状態。
  const [history, setHistory] = useState<SessionHistoryItem[]>([]);
  const auth = useAuth();

  // 本人のセッション履歴を取得して履歴リストへ供給する（#250）。ログイン済みのときだけ叩き、
  // 失敗時は空状態を維持する（履歴は補助情報なので本流＝壁打ち開始は止めない）。idToken が
  // 変わったら取り直す。アンマウント/再取得時の遅延解決は cancelled で握りつぶす。
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
        // 取得失敗（ネットワーク/401 等）は空状態のまま据え置く（UX を止めない）。
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.loggedIn, auth.credential]);

  // 02 準備フォーム（ゴール/役割/同意）を /login 往復で失わないよう復元・保存する（#179）。
  // ハイドレーション不一致を避けるためマウント後に復元し（読み出しが先）、以降の変更を保存する。
  // prepHydrated は *state*（ref ではない）。ref だと同じ初回 effect flush 内で persist が
  // 復元前の既定値を書き戻し、authGate の /login リダイレクトで再描画前にアンマウントされると
  // 入力が既定値で上書きされてしまう（Codex P2）。state にすることで「復元値が反映された
  // render」以降にのみ初回 write が走る。
  const [prepHydrated, setPrepHydrated] = useState(false);
  useEffect(() => {
    const saved = readPrep();
    // 復元する role は既知の選択肢に限定する。古い/壊れた値（例: "designer"）は既定 pm に戻す
    // （未サポート role で createSession を呼ばない / チップ未選択の見た目を防ぐ。Codex P2）。
    if (saved.role && ROLES.some((r) => r.value === saved.role)) setRole(saved.role);
    if (typeof saved.goal === "string") setGoal(saved.goal);
    if (typeof saved.consent === "boolean") setConsent(saved.consent);
    setPrepHydrated(true);
  }, []);
  useEffect(() => {
    if (!prepHydrated) return;
    writePrep({ role, goal, consent });
  }, [prepHydrated, role, goal, consent]);

  // ログアウト時（ログイン中→未ログインの遷移）は準備フォームを破棄する（#179 / Codex P2）。
  // 固定キー sessionStorage を同一タブの別ユーザーへ引き継がせない（goal に PII が入り得る）。
  // 開始成功時の clearPrep と合わせ、保存は「このユーザーの未開始セッション」に限定される。
  const prevLoggedIn = useRef(auth.loggedIn);
  useEffect(() => {
    if (prevLoggedIn.current && !auth.loggedIn) {
      clearPrep();
      setRole("pm");
      setGoal("");
      setConsent(false);
    }
    prevLoggedIn.current = auth.loggedIn;
  }, [auth.loggedIn]);

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
      // 1 件の失敗で開始全体は止めないが、成功した分だけをサマリに渡し、失敗件数は別途知らせる
      // （未登録ファイルを「添付済み」と誤認させない / Codex P2）。
      const uploaded: string[] = [];
      let failed = 0;
      for (const file of staged) {
        try {
          await uploadContextFile(joined.session_id, file, joined.session_token);
          uploaded.push(file.name);
        } catch (uploadErr) {
          failed += 1;
          // PII 回避: ファイル名は出さず、種別・エラーのみ残す（収集先の OTLP/メトリクス配線は #232）。
          console.error("staged material upload failed", { kind: classifyFile(file), error: uploadErr });
        }
      }
      setUploadedNames(uploaded);
      setUploadFailedCount(failed);
      setConn(joined);
      // 壁打ち開始に成功したら準備フォームの一時保存は破棄する（次回へ持ち越さない / #179）。
      clearPrep();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── 参考資料（バイナリ添付）の操作 ────────────────────────────────────────
  // 投入種別の計測 seam（CLAUDE.md 原則3）。準備画面はカメラ/画面共有を出さないため
  // upload/drive のみが流れる。収集先（OTLP/メトリクス基盤）への本配線は #232 だが、それまでも
  // 運用でファネル/誤タップを追えるよう構造化ログを残す（"新しい処理に観測性を通す"）。
  function measureSource(source: MaterialSource) {
    console.info("[material-source] select", { source, surface: "prepare" });
  }

  // 受理判定は API（content-type）と揃える。拡張子（classifyUpload）に加えて File.type も見る
  // ことで、.jfif や拡張子なしでも MIME が image/video なら受理する（Codex P2）。
  function classifyFile(file: File): "image" | "video" | null {
    const byName = classifyUpload(file.name);
    if (byName) return byName;
    const type = file.type.toLowerCase();
    if (type === "image/png" || type === "image/jpeg") return "image";
    if (type === "video/mp4" || type === "video/quicktime") return "video";
    return null;
  }

  // ピッカで選んだファイルをステージする。非対応形式は弾いて理由を出す
  // （API と同じ受理範囲: PNG/JPG・MP4/MOV / 要件票 06）。
  function handleAddFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 同じファイルの再選択でも change を発火させる。
    if (busy || files.length === 0) return; // 開始処理中は投入セットを固定する（Codex P2）。
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (classifyFile(f)) accepted.push(f);
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
    if (busy) return; // 開始処理中は投入セットを固定する（Codex P2）。
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
        // 03-0 開始前サマリの「参考資料」には "実際に投入できた" 名前だけを反映する
        // （未登録ファイルを添付済みと誤認させない / 監査 B-2 #11・Codex P2）。
        materialNames={uploadedNames}
        materialFailedCount={uploadFailedCount}
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
                        disabled={busy}
                        aria-label={`${file.name} を取り外す`}
                        className="ml-[6px] text-[var(--sanba-muted)] disabled:opacity-50"
                      >
                        ✕
                      </button>
                    </Chip>
                  </li>
                ))}
              </ul>
            )}

            {/* 開始処理中（busy）は追加/削除を止める。クリック時点の staged のみが投入されるため、
                遅れて足した資料が「添付済み」に見えて実際は未送信、という齟齬を防ぐ（Codex P2）。 */}
            <button
              type="button"
              onClick={() => {
                setAttachError(null);
                setSheetOpen(true);
              }}
              disabled={busy}
              aria-haspopup="dialog"
              className="rounded-[12px] border border-dashed border-[var(--sanba-gold-deep)] bg-[var(--sanba-surface)] px-3 py-[13px] text-left text-[12.5px] font-bold text-[var(--sanba-gold-text)] disabled:opacity-50"
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
  // 中身は本人のセッション一覧 API（GET /api/sessions/mine / #250）から供給する。0 件や
  // 未ログイン・取得失敗時は SessionHistoryList が空状態の文言を出す。
  return (
    <Screen className="px-4 py-3">
      <AppHeader brand right={<AccountMenu profile={auth.profile} />} />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-3">

        <Card>
          <div className="flex items-start justify-between gap-[12px]">
            <div className="flex flex-col gap-[8px]">
              <h1 className="sanba-display text-[23px] font-bold leading-snug text-[var(--sanba-cream)]">
                会議の前に、五分の問答を
              </h1>
              <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
                一問ずつ問いかけ、抜けと矛盾をその場で取り上げます。
              </p>
            </div>
            {/* サンバさん（歩行）。ホームの待ち時間に体温を与える（ADR-0025、1 画面 1 体まで）。 */}
            <Figure state="walking" className="mt-[2px] w-[44px] shrink-0" />
          </div>
          <Button variant="gold" size="lg" block onClick={() => setStep("prepare")}>
            ＋ 壁打ちを始める
          </Button>
        </Card>
        <SessionHistoryList items={history} />
      </main>
    </Screen>
  );
}
