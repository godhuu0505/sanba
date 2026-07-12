"use client";


import { Check, FileText, Film, Image as ImageIcon, Mic, Package, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  Button,
  Card,
  Chip,
  Field,
  Figure,
  HelpIcon,
  Select,
  Textarea,
} from "@/components/sanba";
import {
  ACCEPTED_DOC,
  ACCEPTED_IMAGE,
  ACCEPTED_SUMMARY,
  ACCEPTED_VIDEO,
  addSessionContext,
  classifyFileUpload,
  createSession,
  fetchMyProducts,
  joinSession,
  type Product,
  uploadContextFile,
  type JoinResponse,
} from "../lib/api";
import { AUDIENCE_LABELS } from "../lib/audience";
import { useAuth } from "../lib/auth";
import { importDriveFile, isDriveConfigured, openDrivePicker } from "../lib/googleDrive";
import { AppShell } from "./AppShell";
import { ConversationStart } from "./ConversationStart";
import { MemberInviteNotices } from "./MemberInviteNotices";
import {
  MaterialSourceSheet,
  type MaterialSource,
} from "./MaterialSourceSheet";
import { authGate } from "./RequireAuth";
import { AccessErrorScreen } from "./AccessErrorScreen";
import { clearPrep, readPrep, writePrep } from "../lib/prepFormStorage";

const ROLES = [
  { value: "customer", label: AUDIENCE_LABELS.end_user },
  { value: "engineer", label: AUDIENCE_LABELS.developer },
] as const;

const DEFAULT_ROLE = "customer";

const HOME_PATH = "/";
const NO_PRODUCT = "__none__";
const PREPARE_PATH_RE = /^\/([^/]+)\/prepare\/?$/;
const SESSION_PATH_RE = /^\/([^/]+)\/sessions\/[^/]+\/?$/;

function preparePath(slug: string): string {
  return `/${encodeURIComponent(slug)}/prepare`;
}

function sessionPath(slug: string, sessionId: string): string {
  return `/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`;
}

const GOAL_EXAMPLES: Record<string, string[]> = {
  customer: [
    "ボタンを押しても動かない状況を改善したい",
    "目的の情報にたどり着けないのを解消したい",
  ],
  engineer: [
    "不具合の再現条件と原因の見立てを整理したい",
    "改修の影響範囲と非機能要件を明確にしたい",
  ],
};

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30";

function FieldBadge({ required }: { required?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`ml-[6px] rounded-[4px] px-[5px] py-[1px] align-middle text-[10px] font-bold ${
        required
          ? "bg-sanba-rec-pale text-sanba-rec-text"
          : "bg-sanba-surface-strong text-sanba-muted"
      }`}
    >
      {required ? "必須" : "任意"}
    </span>
  );
}

type Step = "home" | "prepare";

export default function EntryFlow({
  initialStep = "home",
  initialSlug,
}: {
  initialStep?: Step;
  initialSlug?: string;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [urlSlug, setUrlSlug] = useState<string | null>(initialSlug ?? null);
  const [role, setRole] = useState<string>(DEFAULT_ROLE);
  const [goal, setGoal] = useState("");
  const [goalDetail, setGoalDetail] = useState("");
  const [consent, setConsent] = useState(false);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<File[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [uploadedNames, setUploadedNames] = useState<string[]>([]);
  const [uploadFailedCount, setUploadFailedCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [prepHydrated, setPrepHydrated] = useState(false);
  const auth = useAuth();

  function navigateStep(next: Step) {
    const slugForUrl = next === "prepare" ? (selectedProduct?.slug ?? urlSlug) : null;
    setStep(next);
    setUrlSlug(slugForUrl);
    if (typeof window === "undefined") return;
    const path = next === "prepare" && slugForUrl ? preparePath(slugForUrl) : HOME_PATH;
    if (next === "prepare") {
      window.history.pushState({ sanbaStep: next }, "", path);
    } else if (window.location.pathname !== path) {
      window.history.replaceState({ sanbaStep: next }, "", path);
    }
  }

  useEffect(() => {
    function onPopState() {
      if (typeof window === "undefined") return;
      const path = window.location.pathname;
      const prepareMatch = PREPARE_PATH_RE.exec(path);
      const sessionMatch = SESSION_PATH_RE.exec(path);
      setStep(prepareMatch || sessionMatch ? "prepare" : "home");
      setUrlSlug(
        prepareMatch
          ? decodeURIComponent(prepareMatch[1])
          : sessionMatch
            ? decodeURIComponent(sessionMatch[1])
            : null,
      );
      if (!sessionMatch) setConn(null);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedProduct = productId
    ? (products ?? []).find((p) => p.id === productId)
    : undefined;

  useEffect(() => {
    if (!auth.loggedIn || products !== null) return;
    let cancelled = false;
    fetchMyProducts(auth.credential)
      .then((items) => {
        if (!cancelled) setProducts(items);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.loggedIn, auth.credential, products]);

  useEffect(() => {
    if (!products) return;
    if (urlSlug) {
      const bySlug = products.find((p) => p.slug === urlSlug);
      if (bySlug && bySlug.id !== productId) setProductId(bySlug.id);
      return;
    }
    if (productId === NO_PRODUCT) return;
    if (productId !== "" && !products.some((p) => p.id === productId)) {
      setProductId("");
      return;
    }
    if (products.length === 1 && productId === "") {
      setProductId(products[0].id);
      return;
    }
    const selected = products.find((p) => p.id === productId);
    if (step === "prepare" && prepHydrated && (!selected || !selected.slug)) {
      console.info("[entry-flow] fallback to home", { reason: "product-unselected" });
      navigateStep("home");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, productId, step, prepHydrated, urlSlug]);

  useEffect(() => {
    const saved = readPrep();
    if (saved.role && ROLES.some((r) => r.value === saved.role)) setRole(saved.role);
    if (typeof saved.goal === "string") setGoal(saved.goal);
    if (typeof saved.goalDetail === "string") setGoalDetail(saved.goalDetail);
    if (typeof saved.consent === "boolean") setConsent(saved.consent);
    if (typeof saved.productId === "string") setProductId(saved.productId);
    setPrepHydrated(true);
  }, []);
  useEffect(() => {
    if (!prepHydrated) return;
    writePrep({
      role,
      goal,
      goalDetail,
      consent,
      productId,
    });
  }, [prepHydrated, role, goal, goalDetail, consent, productId]);

  const prevLoggedIn = useRef(auth.loggedIn);
  useEffect(() => {
    if (prevLoggedIn.current && !auth.loggedIn) {
      clearPrep();
      setRole(DEFAULT_ROLE);
      setGoal("");
      setGoalDetail("");
      setConsent(false);
      setProductId("");
      setProducts(null);
    }
    prevLoggedIn.current = auth.loggedIn;
  }, [auth.loggedIn]);

  const gate = authGate(auth, step === "prepare" && urlSlug ? preparePath(urlSlug) : HOME_PATH);
  if (gate) return gate;

  if (
    step === "prepare" &&
    urlSlug !== null &&
    products !== null &&
    !products.some((p) => p.slug === urlSlug)
  ) {
    return <AccessErrorScreen />;
  }

  async function handleStart() {
    if (busy || driveBusy) return;
    try {
      setBusy(true);
      setError(null);
      const session = await createSession(
        [role],
        consent,
        auth.credential,
        undefined,
        undefined,
        selectedProduct?.id,
        goal,
        goalDetail,
      );
      const invite = session.invites[role];
      const joined = await joinSession({
        invite,
        participantName: auth.profile?.name || "ゲスト",
        idToken: auth.credential,
      });
      if (goal.trim()) {
        await addSessionContext(joined.session_id, goal, joined.session_token, "goal");
      }
      if (goalDetail.trim()) {
        await addSessionContext(
          joined.session_id,
          goalDetail,
          joined.session_token,
          "goal_detail",
        );
      }
      if (selectedProduct) {
        const productContext = [
          selectedProduct.name,
          selectedProduct.description,
          selectedProduct.glossary.length > 0
            ? `用語: ${selectedProduct.glossary.join("、")}`
            : "",
        ]
          .filter((s) => s.trim())
          .join("\n");
        if (productContext.trim()) {
          try {
            await addSessionContext(
              joined.session_id,
              productContext,
              joined.session_token,
              "product",
            );
          } catch (productErr) {
            console.error("seed product context failed", { error: productErr });
          }
        }
      }
      const uploaded: string[] = [];
      let failed = 0;
      for (const file of staged) {
        try {
          await uploadContextFile(joined.session_id, file, joined.session_token);
          uploaded.push(file.name);
        } catch (uploadErr) {
          failed += 1;
          console.error("staged material upload failed", { kind: classifyFile(file), error: uploadErr });
        }
      }
      setUploadedNames(uploaded);
      setUploadFailedCount(failed);
      setConn(joined);
      if (typeof window !== "undefined" && selectedProduct?.slug) {
        window.history.pushState(
          { sanbaStep: "session" },
          "",
          sessionPath(selectedProduct.slug, joined.session_id),
        );
      }
      clearPrep();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function measureSource(source: MaterialSource) {
    console.info("[material-source] select", { source, surface: "prepare" });
  }

  const classifyFile = classifyFileUpload;

  function stageFiles(accepted: File[]) {
    if (accepted.length === 0) return;
    setStaged((prev) => {
      const key = (f: File) => `${f.name}:${f.size}`;
      const seen = new Set(prev.map(key));
      return [...prev, ...accepted.filter((f) => !seen.has(key(f)))];
    });
  }

  function handleAddFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (busy || driveBusy || files.length === 0) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (classifyFile(f)) accepted.push(f);
      else rejected.push(f.name);
    }
    stageFiles(accepted);
    setAttachError(
      rejected.length > 0
        ? `対応していない形式です（${ACCEPTED_SUMMARY}）: ${rejected.join("、")}`
        : null,
    );
  }

  async function handleDriveImport() {
    if (busy || driveBusy) return;
    setAttachError(null);
    if (!isDriveConfigured()) {
      setAttachError(
        "Google ドライブ連携はこの環境では利用できません（Google API キーが未設定です）。",
      );
      return;
    }
    const token = await auth.requestDriveAccess();
    if (!token) {
      setAttachError(
        "Google ドライブへのアクセスが許可されていません。もう一度お試しいただくと、再度許可を求めます。",
      );
      return;
    }
    setSheetOpen(false);
    let picked: Awaited<ReturnType<typeof openDrivePicker>>;
    try {
      picked = await openDrivePicker(token);
    } catch (e) {
      console.error("drive picker failed", e);
      setAttachError("Google ドライブを開けませんでした。時間をおいて再度お試しください。");
      return;
    }
    if (picked.length === 0) return;
    setDriveBusy(true);
    const imported: File[] = [];
    const failed: string[] = [];
    for (const doc of picked) {
      try {
        imported.push(await importDriveFile(token, doc));
      } catch (e) {
        console.error("drive import failed", e);
        failed.push(doc.name);
      }
    }
    setDriveBusy(false);
    stageFiles(imported);
    if (failed.length > 0) {
      setAttachError(`Google ドライブから取り込めなかったファイルがあります: ${failed.join("、")}`);
    }
  }

  function removeStaged(index: number) {
    if (busy || driveBusy) return;
    setStaged((prev) => prev.filter((_, i) => i !== index));
    setAttachError(null);
  }

  if (conn) {
    const roleLabel = ROLES.find((r) => r.value === role)?.label ?? role;
    return (
      <ConversationStart
        conn={conn}
        goal={goal}
        roleLabel={roleLabel}
        materialNames={uploadedNames}
        materialFailedCount={uploadFailedCount}
        onCancel={() => {
          setConn(null);
          if (typeof window !== "undefined" && SESSION_PATH_RE.test(window.location.pathname)) {
            window.history.back();
          }
        }}
      />
    );
  }

  if (step === "prepare") {
    const canStart =
      consent &&
      goal.trim() !== "" &&
      (productId === NO_PRODUCT || (selectedProduct !== undefined && !!selectedProduct.slug)) &&
      auth.loggedIn &&
      !busy &&
      !driveBusy;
    return (
      <AppShell
        current="home"
        title="セッション準備"
        onBack={() => navigateStep("home")}
      >
        <div className="mx-auto flex w-full max-w-[480px] flex-col gap-[18px] px-4 py-4 lg:max-w-[680px] lg:py-6">
          {}
          <div className="flex items-center gap-[8px] rounded-[12px] border border-sanba-border bg-sanba-surface px-[12px] py-[10px]">
            <Package size={16} aria-hidden className="shrink-0 text-sanba-gold-text" />
            <span className="shrink-0 text-[12px] font-bold text-sanba-muted">対象のアプリ</span>
            {}
            <span
              aria-live="polite"
              className="min-w-0 flex-1 truncate text-right text-[13px] font-bold text-sanba-cream"
            >
              {selectedProduct
                ? selectedProduct.name
                : productId === NO_PRODUCT
                  ? "指定しない"
                  : "確認しています…"}
            </span>
          </div>

          {}
          <div className="flex flex-col gap-[8px]">
            <span className="text-[13px] font-bold text-sanba-muted">
              あなたの役割
              <FieldBadge required />
            </span>
            <div
              role="radiogroup"
              aria-label="あなたの役割"
              aria-required="true"
              className="flex flex-wrap gap-[8px]"
            >
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
                      {selected && <Check size={13} aria-hidden className="mr-1 inline-block align-[-2px]" />}
                      {r.label}
                    </button>
                  </Chip>
                );
              })}
            </div>
          </div>

          <Field label="ゴール" marker={<FieldBadge required />} htmlFor="goal">
            <Textarea
              id="goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={1}
              aria-required="true"
              placeholder="ゴールを入力…"
              className="resize-y"
              maxLength={2000}
            />
            {}
            <div className="flex flex-col gap-[3px] text-[12px] leading-relaxed text-sanba-muted/80">
              {(GOAL_EXAMPLES[role] ?? GOAL_EXAMPLES[DEFAULT_ROLE]).map((example) => (
                <span key={example}>例：{example}</span>
              ))}
            </div>
          </Field>

          <Field
            label="ゴールの詳細"
            marker={<FieldBadge />}
            htmlFor="goal-detail"
            hint="例: いまは検索が遅く目的の項目に辿り着けない。まずは対象範囲と優先度を整理したい。"
          >
            <Textarea
              id="goal-detail"
              value={goalDetail}
              onChange={(e) => setGoalDetail(e.target.value)}
              rows={4}
              placeholder="背景・現状・制約・期待する成果などを自由に入力…"
              className="resize-y"
              maxLength={8000}
            />
          </Field>

          {}
          <div className="flex flex-col gap-[8px]">
            <span className="text-[13px] font-bold text-sanba-muted">
              参考資料（任意）
            </span>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              PNG・JPG・MP4・MOV・PDF・Word・Excel・PowerPoint・Markdown・HTML・CSV 等。
              Google ドライブのドキュメント・スプレッドシート・スライドも取り込めます。
            </p>


            {}
            <button
              type="button"
              onClick={() => {
                setAttachError(null);
                setSheetOpen(true);
              }}
              disabled={busy || driveBusy}
              aria-haspopup="dialog"
              className="inline-flex items-center gap-1.5 rounded-[12px] border border-dashed border-sanba-gold-deep bg-sanba-surface px-3 py-[13px] text-left text-[12.5px] font-bold text-sanba-gold-text disabled:opacity-50"
            >
              <Plus size={14} aria-hidden /> ファイルを追加
            </button>

            {}
            {staged.length > 0 && (
              <ul aria-label="添付した参考資料" className="flex flex-col gap-[8px]">
                {staged.map((file, i) => {
                  const kind = classifyFile(file);
                  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : FileText;
                  return (
                    <li
                      key={`${file.name}:${file.size}`}
                      className="flex items-center gap-[10px] rounded-[12px] border border-sanba-border bg-sanba-surface px-[10px] py-[8px]"
                    >
                      <span className="flex size-[40px] shrink-0 items-center justify-center rounded-[8px] border border-sanba-border bg-sanba-surface-strong text-sanba-muted">
                        <Icon size={18} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-sanba-cream">
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeStaged(i)}
                        disabled={busy || driveBusy}
                        aria-label={`${file.name} を取り外す`}
                        className="flex size-[26px] shrink-0 items-center justify-center rounded-full text-sanba-muted disabled:opacity-50"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {driveBusy && (
              <p role="status" className="text-[12px] text-sanba-muted">
                Google ドライブから取り込んでいます…
              </p>
            )}
            {attachError && (
              <p role="alert" className="text-[12px] text-sanba-rec-text">
                {attachError}
              </p>
            )}
          </div>

          {}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={`${ACCEPTED_IMAGE},${ACCEPTED_VIDEO},${ACCEPTED_DOC}`}
            onChange={handleAddFiles}
            className="hidden"
          />

          {}
          <div className="flex items-start gap-[6px]">
            <label className="flex items-start gap-[10px] text-[13px] leading-relaxed text-sanba-cream">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                aria-required="true"
                className="mt-[3px] size-[16px] accent-sanba-gold"
              />
              <span>
                録音とAI処理に同意します（最大{RETENTION_DAYS}日保持）
                <FieldBadge required />
              </span>
            </label>
            <HelpIcon term="録音とデータの扱い" className="mt-[2px] shrink-0" />
          </div>

          <div className="mt-1 flex flex-col gap-[8px]">
            <Button
              variant="gold"
              size="lg"
              block
              onClick={handleStart}
              disabled={!canStart}
              aria-label="会話を始める"
            >
              {busy ? (
                "準備しています…"
              ) : (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Mic size={16} aria-hidden /> 会話を始める
                </span>
              )}
            </Button>
            {!auth.loggedIn && (
              <p className="text-[12px] text-sanba-muted">
                開始するには本人確認が必要です。
                <Link href="/login" className="ml-1 text-sanba-gold-text underline">
                  ログインへ
                </Link>
              </p>
            )}
            {auth.loggedIn && goal.trim() === "" && (
              <p className="text-[12px] text-sanba-muted">ゴールの入力が必要です。</p>
            )}
            {auth.loggedIn && !consent && (
              <p className="text-[12px] text-sanba-muted">
                録音と AI 処理への同意が必要です。
              </p>
            )}
            {error && <p className="text-[12px] text-sanba-rec-text">{error}</p>}
          </div>
        </div>

        {}
        {sheetOpen && (
          <MaterialSourceSheet
            placement="center"
            onClose={() => setSheetOpen(false)}
            onUpload={() => {
              setSheetOpen(false);
              fileInput.current?.click();
            }}
            onDrive={() => void handleDriveImport()}
            onSelectSource={measureSource}
            error={attachError}
          />
        )}
      </AppShell>
    );
  }

  return (
    <AppShell current="home">
      {}
      <div className="m-auto flex w-full max-w-[480px] flex-col gap-[18px] px-4 py-6 lg:max-w-[560px]">
        {}
        <MemberInviteNotices />
        <Card>
          <div className="flex items-start justify-between gap-[12px]">
            <div className="flex flex-col gap-[8px]">
              <h1 className="sanba-display text-[23px] font-bold leading-snug text-sanba-cream">
                会議の前に、五分の会話を
              </h1>
              <p className="text-[13px] leading-relaxed text-sanba-muted">
                一問ずつ問いかけ、食い違いや確認したい点をその場で取り上げます。
              </p>
            </div>
            {}
            <Figure state="walking" className="mt-[2px] w-[44px] shrink-0" />
          </div>
          {}
          <Field
            label="対象のアプリ"
            marker={
              <>
                <FieldBadge />
                <HelpIcon term="対象のアプリ" className="ml-[6px]" />
              </>
            }
            htmlFor="product"
            hint={
              products === null
                ? "登録済みのアプリを確認しています…"
                : "対象のアプリを選ぶと、その用語や前提リポジトリのコードを会話の質問の背景に取り込みます。特定のアプリに紐づけない場合は「指定しない」を選んでください。"
            }
          >
            <Select
              id="product"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
            >
              <option value="">選択してください</option>
              <option value={NO_PRODUCT}>指定しない</option>
              {(products ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {}
                  {p.slug ? p.name : `${p.name}（URL キーワード未設定）`}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="gold"
            size="lg"
            block
            onClick={() => navigateStep("prepare")}
            disabled={productId !== NO_PRODUCT && !selectedProduct?.slug}
          >
            ＋ 会話を始める
          </Button>
          {products !== null && productId === "" && (
            <p className="text-[12px] text-sanba-muted">
              対象のアプリを選ぶか、「指定しない」で会話を始められます。
            </p>
          )}
          {}
          {selectedProduct && !selectedProduct.slug && (
            <p className="text-[12px] text-sanba-muted">
              このアプリは URL キーワードが未設定のため、会話を始められません。
              <Link
                href={`/products/${encodeURIComponent(selectedProduct.id)}`}
                className="ml-1 text-sanba-gold-text underline"
              >
                アプリ管理で設定する
              </Link>
            </p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
