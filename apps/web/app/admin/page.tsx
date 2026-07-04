"use client";

// 管理画面「管理の間」(ADR-0014 §3 / Figma 正本 31:2・黄金テーマ 73-8..11)。
// 91 一覧 → 92 作成（招待発行）→ 94 アクセスゲート。
// 旧 93「要件を検める」(改める/認める/退ける) は廃止: 要件の閲覧はホーム履歴からの
// 絵巻閲覧画面 (/sessions/[id]) が担い、管理画面はセッションの興し・一覧に限定する。
// 認可の源泉は API 側 (ADMIN_EMAILS)。クライアントのガードは UX 用で、真偽は 401/403 で判定する (§7)。
// 意匠は SANBA デザインシステム（components/sanba/*）の金彩テーマを再利用し、ロジックは変えない。

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ApiError, type AdminSession, createSession, listAdminSessions } from "@/lib/api";
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
  Screen,
  SessionRow,
} from "@/components/sanba";

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
  // 91 一覧 ⇆ 92 作成の画面遷移（Figma 73:8/73:9）。実装は 91 内アコーディオンだったが、
  // Figma 正本に合わせ「＋ セッションを興す」CTA → 専用画面 92 へ分離する（#220）。
  const [view, setView] = useState<"home" | "create">("home");

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
        {/* 401 では共有 AuthProvider に期限切れ credential が残り loggedIn=true のまま。
            そのまま /login へ送ると即 / へ replace され GIS 再認証ボタンが出ない。ここで
            signOut して credential を clear し、authGate 経由で /login?next=/admin（GIS）へ送る。
            期限切れ回復であり明示ログアウトではないため、他タブへは伝播させない
            （broadcast:false / 別タブの進行中会話を巻き添えにしない / ADR-0030）。 */}
        <Button variant="gold" block onClick={() => auth.signOut({ broadcast: false })}>
          ログインへ
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

  // ── 92 新たな問答を興す（専用作成画面 / Figma 73:9）─────────────
  // 91 から「＋ セッションを興す」CTA で遷移する独立画面。戻るで 91 一覧へ戻り、
  // 戻る前後で loadSessions により一覧へ反映する（作成成功時に onCreated で再取得済み）。
  if (view === "create") {
    return (
      <Screen className="sanba-scroll">
        <AppHeader back onBack={() => setView("home")} title="新たな問答を興す" />
        <main className="mx-auto flex w-full max-w-md flex-col gap-[18px] px-[16px] pb-[40px] pt-[6px]">
          <CreateSessionCard idToken={idToken} onCreated={() => void loadSessions()} />
        </main>
      </Screen>
    );
  }

  // ── 91 管理ホーム（セッション一覧）─────────────────────────────
  return (
    <Screen className="sanba-scroll">
      <AppHeader
        back
        // 戻るはホームへ。/login はログイン済みだと即 / へ replace するため、そこへ送ると
        // 履歴が /admin→/ となりブラウザ戻るで /admin に戻るループになる（直接 / へ送る）。
        onBack={() => router.push("/")}
        title="管理の間"
        right={<AccountMenu profile={auth.profile} hideAdmin />}
      />
      <main className="mx-auto flex w-full max-w-md flex-col gap-[18px] px-[16px] pb-[40px] pt-[6px]">
        {/* 主 CTA（Figma 73:8 / 76:11）。専用作成画面 92 へ遷移する。 */}
        <Button variant="gold" block onClick={() => setView("create")}>
          ＋ セッションを興す
        </Button>

        <section className="flex flex-col gap-[12px]">
          <h2 className="text-[13px] font-bold tracking-[0.18em] text-[var(--sanba-gold-text)]">
            進行中の問答
          </h2>
          {sessions.length === 0 ? (
            <p className="text-[13px] text-[var(--sanba-muted)]">問答がまだございません。</p>
          ) : (
            <div className="flex flex-col gap-[10px]">
              {/* 旧 93「要件を検める」展開は廃止（要件閲覧は /sessions/[id] の絵巻閲覧画面へ）。
                  行は閲覧専用のメタ表示に留める。 */}
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  title={s.title}
                  meta={`${s.owner_email} ・ ${formatDate(s.created_at)}`}
                  // 押せない行に既定の「検める ›」ピルを残さない（Codex P2）。
                  action={null}
                />
              ))}
            </div>
          )}
        </section>
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
    <Screen>
      {/* どの画面でも SANBA ヘッダー（2026-07 要望）。アクセスゲート中もブランドを保つ。 */}
      <AppHeader />
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
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
  // 既定は Figma 92（76:46）に合わせ「企画(PdM)」単一選択（実装は従来 3 役割すべてが既定だった / #220・監査 B-3 #16）。
  // 複数選択は維持し、roles.length===0 で送信無効化のバリデーションも不変。
  const [roles, setRoles] = useState<string[]>([ROLES[0].value]);
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

function formatDate(iso: string): string {
  // SSR/CSR で表記揺れしないよう ISO の日付部分だけを使う。
  return iso.slice(0, 10);
}
