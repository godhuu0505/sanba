"use client";

// 管理画面「管理の間」(ADR-0014 §3 / Figma 正本 31:2・黄金テーマ 73-8..11)。
// 91 一覧 → 92 作成（招待発行）→ 93 要件を検める（改める/認める/退ける）→ 94 アクセスゲート。
// 閲覧は requirements のみ。生の発話 (utterances) は出さない (issue #10 / §3)。
// 認可の源泉は API 側 (ADMIN_EMAILS)。クライアントのガードは UX 用で、真偽は 401/403 で判定する (§7)。
// 意匠は SANBA デザインシステム（components/sanba/*）の金彩テーマを再利用し、ロジックは変えない。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  ApiError,
  type AdminRequirement,
  type AdminSession,
  type RequirementStatus,
  createSession,
  listAdminSessions,
  listSessionRequirements,
  updateRequirement,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AccountMenu } from "@/components/AccountMenu";
import { authGate } from "@/components/RequireAuth";
import {
  AppHeader,
  Button,
  Card,
  CardTitle,
  Chip,
  Field,
  Input,
  RequirementCard,
  Screen,
  Select,
  SessionRow,
  Textarea,
} from "@/components/sanba";

const PRIORITIES = ["must", "should", "could", "wont"] as const;
const CATEGORIES = [
  "functional",
  "non_functional",
  "constraint",
  "scope",
  "open_question",
] as const;

// 招く者の役割。selected の単一選択ではなく複数選択（既定は全員）。
const ROLES: { value: string; label: string }[] = [
  { value: "pm", label: "企画(PdM)" },
  { value: "engineer", label: "エンジニア" },
  { value: "customer", label: "顧客" },
];

type Access = "loading" | "ok" | "unauthenticated" | "forbidden" | "error";

export default function AdminPage() {
  const auth = useAuth();
  const router = useRouter();
  const idToken = auth.credential;

  const [access, setAccess] = useState<Access>("loading");
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    // dev モードは idToken=null のまま API の AUTH_DEV_BYPASS に委ねる。
    if (!auth.devMode && !auth.loggedIn) {
      setAccess("unauthenticated");
      return;
    }
    try {
      setAccess("loading");
      const data = await listAdminSessions(idToken);
      setSessions(data);
      setAccess("ok");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAccess("unauthenticated");
      else if (e instanceof ApiError && e.status === 403) setAccess("forbidden");
      else setAccess("error");
    }
  }, [auth.devMode, auth.loggedIn, idToken]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // 厳密な認証ゲート（全画面保護）。未ログインは /login?next=/admin へ戻す。判定は
  // authGate に集約（dev は AUTH_DEV_BYPASS に委ねて素通し）。認可（管理者判定）は下の access で 403 表示する。
  const gate = authGate(auth, "/admin");
  if (gate) return gate;

  // ── 94 アクセスゲート（loading / 401 / 403 / error）──────────────
  if (access === "loading") {
    return (
      <Gate title="読み込み中…" eyebrow="しばしお待ちを">
        <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
          アクセス権を確かめております。
        </p>
      </Gate>
    );
  }
  if (access === "unauthenticated") {
    return (
      <Gate title="ログインが必要です" eyebrow="401 — 本人を確かめます">
        <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
          問答と要件を検めるには、まず本人を確かめます。
        </p>
        <Button asChild variant="gold" block>
          <Link href="/login">ログインへ</Link>
        </Button>
      </Gate>
    );
  }
  if (access === "forbidden") {
    return (
      <Gate title="管理者の権限がありません" eyebrow="403 — 管理者でない" icon="⊘">
        <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">
          このアカウントには管理者の権限がありません。必要な場合はシステム管理者にお問い合わせください。
        </p>
      </Gate>
    );
  }
  if (access === "error") {
    return (
      <Gate title="読み込みに失敗しました" eyebrow="しくじり">
        <Button variant="gold" block onClick={() => void loadSessions()}>
          再び試みる
        </Button>
      </Gate>
    );
  }

  // ── 91 管理ホーム（セッション一覧）─────────────────────────────
  return (
    <Screen className="sanba-scroll">
      <AppHeader
        back
        onBack={() => router.push("/login")}
        title="管理の間"
        right={<AccountMenu profile={auth.profile} hideAdmin />}
      />
      <main className="mx-auto flex w-full max-w-md flex-col gap-[18px] px-[16px] pb-[40px] pt-[6px]">
        <CreateSessionCard idToken={idToken} onCreated={() => void loadSessions()} />

        <section className="flex flex-col gap-[12px]">
          <h2 className="text-[13px] font-bold tracking-[0.18em] text-[var(--sanba-gold-text)]">
            進行中の問答
          </h2>
          {sessions.length === 0 ? (
            <p className="text-[13px] text-[var(--sanba-muted)]">問答がまだございません。</p>
          ) : (
            <div className="flex flex-col gap-[10px]">
              {sessions.map((s) => {
                const open = selected === s.id;
                const toggle = () => setSelected(open ? null : s.id);
                return (
                  // SessionRow は内部で複数の子（標題＋操作ピル）を描くため asChild(Slot) は使えない。
                  // div のまま role/tabIndex/キー操作を載せてクリック可能な行にする。
                  <SessionRow
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                    className="cursor-pointer text-left focus-visible:outline-none focus-visible:border-[var(--sanba-gold)]"
                    title={s.title}
                    meta={`${s.owner_email} ・ ${formatDate(s.created_at)}`}
                    action={open ? "閉じる" : "検める ›"}
                  />
                );
              })}
            </div>
          )}
        </section>

        {selected && (
          <RequirementsPanel
            sessionId={selected}
            title={sessions.find((s) => s.id === selected)?.title ?? ""}
            idToken={idToken}
          />
        )}
      </main>
    </Screen>
  );
}

// ── 94 ゲートの共通枠 ────────────────────────────────────────────
function Gate({
  title,
  eyebrow,
  icon,
  children,
}: {
  title: string;
  eyebrow?: string;
  /** タイトル横に出す記号（例: 403 の ⊘）。色のみに依存しない判別の補助。 */
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <Screen className="items-center justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        {eyebrow && (
          <p className="mb-2 text-[12px] tracking-[0.2em] text-[var(--sanba-gold-text)]">
            ✦ {eyebrow} ✦
          </p>
        )}
        <Card>
          <CardTitle>
            {icon && <span aria-hidden="true">{icon} </span>}
            {title}
          </CardTitle>
          {children}
        </Card>
      </div>
    </Screen>
  );
}

// ── 92 セッションを興す（標題・役割・招待発行）─────────────────
function CreateSessionCard({
  idToken,
  onCreated,
}: {
  idToken: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("要件インタビュー");
  const [roles, setRoles] = useState<string[]>(ROLES.map((r) => r.value));
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(value: string) {
    setRoles((prev) =>
      prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value],
    );
  }

  async function handleCreate() {
    try {
      setBusy(true);
      setError(null);
      // owner 作成も consent 必須 (issue #10)。管理者が作るので明示同意済みとして渡す。
      // role は ROLES の並びに揃えて発行する（表示と招待の符の順を一致させる）。
      const ordered = ROLES.map((r) => r.value).filter((v) => roles.includes(v));
      const res = await createSession(ordered, true, idToken, title);
      setInvites(res.invites);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>セッションを作成</CardTitle>
      <Field label="標題（ゴール）" htmlFor="title">
        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="flex flex-col gap-[6px]">
        <span className="text-[13px] font-bold text-[var(--sanba-muted)]">招く者の役割</span>
        <div className="flex flex-wrap gap-[8px]">
          {ROLES.map((r) => (
            <Chip key={r.value} asChild tone="gold" size="md" selected={roles.includes(r.value)}>
              {/* asChild の Slot は単一子のみ。選択ドットは子の中で描く。 */}
              <button type="button" onClick={() => toggleRole(r.value)}>
                {roles.includes(r.value) && <span aria-hidden>● </span>}
                {r.label}
              </button>
            </Chip>
          ))}
        </div>
      </div>
      <Button
        variant="gold"
        block
        onClick={() => void handleCreate()}
        disabled={busy || roles.length === 0}
      >
        {busy ? "発行しております…" : "作成して招待を発行"}
      </Button>
      {error && <p className="text-[13px] text-[var(--sanba-rec)]">{error}</p>}
      {invites && (
        <div className="flex flex-col gap-[6px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-bg)]/40 px-[14px] py-[12px]">
          <p className="text-[13px] font-bold text-[var(--sanba-gold-text)]">
            招待の符（role ごと）
          </p>
          {Object.entries(invites).map(([role, token]) => (
            <p key={role} className="break-all text-[12px] text-[var(--sanba-cream)]">
              <span className="font-bold">{role}:</span>{" "}
              <code className="text-[var(--sanba-muted)]">{token}</code>
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── 93 要件を検める ─────────────────────────────────────────────
function RequirementsPanel({
  sessionId,
  title,
  idToken,
}: {
  sessionId: string;
  title: string;
  idToken: string | null;
}) {
  const [reqs, setReqs] = useState<AdminRequirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setReqs(await listSessionRequirements(sessionId, idToken));
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, idToken]);

  useEffect(() => {
    void load();
  }, [load]);

  function replace(updated: AdminRequirement) {
    setReqs((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? null);
  }

  return (
    <section className="flex flex-col gap-[12px]">
      <div className="flex flex-col gap-[2px]">
        <h2 className="text-[18px] font-bold text-[var(--sanba-cream)]">要件を検める</h2>
        <p className="text-[12px] text-[var(--sanba-muted)]">
          {sessionId}
          {title ? ` ・ ${title}` : ""}
        </p>
      </div>
      {error && <p className="text-[13px] text-[var(--sanba-rec)]">{error}</p>}
      {reqs === null ? (
        <p className="text-[13px] text-[var(--sanba-muted)]">読み込み中…</p>
      ) : reqs.length === 0 ? (
        <p className="text-[13px] text-[var(--sanba-muted)]">
          この要件はまだ生まれておりませぬ。
        </p>
      ) : (
        <div className="flex flex-col gap-[10px]">
          {reqs.map((r) => (
            <RequirementRow
              key={r.id}
              sessionId={sessionId}
              idToken={idToken}
              req={r}
              onChange={replace}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RequirementRow({
  sessionId,
  idToken,
  req,
  onChange,
}: {
  sessionId: string;
  idToken: string | null;
  req: AdminRequirement;
  onChange: (r: AdminRequirement) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(req.statement);
  const [priority, setPriority] = useState(req.priority);
  const [category, setCategory] = useState(req.category);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(patch: Parameters<typeof updateRequirement>[2]) {
    try {
      setBusy(true);
      setError(null);
      onChange(await updateRequirement(sessionId, req.id, patch, idToken));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdits() {
    await persist({ statement, priority, category });
    setEditing(false);
  }

  // 編集中は素の枠で編集フォームを描く。閲覧時は RequirementCard（状態チップ＋三択）。
  if (editing) {
    return (
      <Card>
        <Field label="記述">
          <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={3} />
        </Field>
        <div className="flex flex-wrap gap-[12px]">
          <Field label="優先度" className="min-w-[140px] flex-1">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="分類" className="min-w-[140px] flex-1">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex gap-[8px]">
          <Button variant="gold" size="sm" onClick={() => void saveEdits()} disabled={busy}>
            奉る
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatement(req.statement);
              setPriority(req.priority);
              setCategory(req.category);
              setEditing(false);
            }}
          >
            取りやめる
          </Button>
        </div>
        {error && <p className="text-[13px] text-[var(--sanba-rec)]">{error}</p>}
      </Card>
    );
  }

  return (
    <>
      {error && <p className="text-[13px] text-[var(--sanba-rec)]">{error}</p>}
      <RequirementCard
        status={req.status}
        confidence={`${req.source_speaker ?? "—"} ・ 確度 ${Math.round(req.confidence * 100)}%`}
        statement={req.statement}
        meta={
          <>
            優先度: {req.priority} ・ 分類: {req.category}
            {req.approved_by ? ` ・ 認: ${req.approved_by}` : ""}
          </>
        }
        onRevise={busy ? undefined : () => setEditing(true)}
        onApprove={
          busy || req.status === "approved" ? undefined : () => void persist({ status: "approved" })
        }
        onReject={
          busy || req.status === "rejected" ? undefined : () => void persist({ status: "rejected" })
        }
      />
    </>
  );
}

function formatDate(iso: string): string {
  // SSR/CSR で表記揺れしないよう ISO の日付部分だけを使う。
  return iso.slice(0, 10);
}
