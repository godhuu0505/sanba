"use client";

// 管理画面 (ADR-0014 §3)。セッション一覧・要件の編集/承認・セッション作成を行う。
// 閲覧は requirements のみ。生の発話 (utterances) は出さない (issue #10 / §3)。
// 認可の源泉は API 側 (ADMIN_EMAILS)。クライアントのガードは UX 用で、真偽は 401/403 で判定する (§7)。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
import { useGoogleAuth } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const PRIORITIES = ["must", "should", "could", "wont"] as const;
const CATEGORIES = [
  "functional",
  "non_functional",
  "constraint",
  "scope",
  "open_question",
] as const;

type Access = "loading" | "ok" | "unauthenticated" | "forbidden" | "error";

export default function AdminPage() {
  const auth = useGoogleAuth();
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

  if (access === "unauthenticated") {
    return (
      <Gate title="ログインが必要です">
        <Button asChild>
          <Link href="/login">ログインへ</Link>
        </Button>
      </Gate>
    );
  }
  if (access === "forbidden") {
    return (
      <Gate title="管理者権限がありません">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          このアカウントは管理者として登録されていません（ADMIN_EMAILS）。
        </p>
      </Gate>
    );
  }
  if (access === "error") {
    return (
      <Gate title="読み込みに失敗しました">
        <Button onClick={() => void loadSessions()}>再試行</Button>
      </Gate>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">SANBA 管理画面</h1>
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">ログイン状態</Link>
        </Button>
      </header>

      <div className="flex flex-col gap-6">
        <CreateSessionCard idToken={idToken} onCreated={() => void loadSessions()} />

        <Card>
          <CardHeader>
            <CardTitle>セッション一覧</CardTitle>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">
                セッションがまだありません。
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>タイトル</TableHead>
                    <TableHead>オーナー</TableHead>
                    <TableHead>作成日時</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.title}</TableCell>
                      <TableCell>{s.owner_email}</TableCell>
                      <TableCell>{formatDate(s.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant={selected === s.id ? "secondary" : "outline"}
                          size="sm"
                          onClick={() => setSelected(selected === s.id ? null : s.id)}
                        >
                          {selected === s.id ? "閉じる" : "要件を見る"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {selected && <RequirementsPanel sessionId={selected} idToken={idToken} />}
      </div>
    </main>
  );
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">{children}</CardContent>
      </Card>
    </main>
  );
}

function CreateSessionCard({
  idToken,
  onCreated,
}: {
  idToken: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("要件インタビュー");
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    try {
      setBusy(true);
      setError(null);
      // owner 作成も consent 必須 (issue #10)。管理者が作るので明示同意済みとして渡す。
      const res = await createSession(["pm", "engineer", "customer"], true, idToken);
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
      <CardHeader>
        <CardTitle>セッションを作成</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">タイトル</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Button onClick={() => void handleCreate()} disabled={busy}>
            {busy ? "作成中…" : "作成して招待を発行"}
          </Button>
        </div>
        {error && <p className="text-sm text-[var(--color-destructive)]">{error}</p>}
        {invites && (
          <div className="flex flex-col gap-1 rounded-md bg-[var(--color-muted)] p-3 text-sm">
            <p className="font-medium">招待トークン（role ごと）</p>
            {Object.entries(invites).map(([role, token]) => (
              <p key={role} className="break-all">
                <span className="font-medium">{role}:</span> <code>{token}</code>
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RequirementsPanel({
  sessionId,
  idToken,
}: {
  sessionId: string;
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
    <Card>
      <CardHeader>
        <CardTitle>要件（{sessionId}）</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-[var(--color-destructive)]">{error}</p>}
        {reqs === null ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">読み込み中…</p>
        ) : reqs.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            この要件はまだ生成されていません。
          </p>
        ) : (
          reqs.map((r) => (
            <RequirementRow
              key={r.id}
              sessionId={sessionId}
              idToken={idToken}
              req={r}
              onChange={replace}
            />
          ))
        )}
      </CardContent>
    </Card>
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

  return (
    <div className="rounded-md border border-[var(--color-border)] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <StatusBadge status={req.status} />
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {req.source_speaker ?? "—"} / 確度 {Math.round(req.confidence * 100)}%
        </span>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>記述</Label>
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={3} />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>優先度</Label>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>分類</Label>
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void saveEdits()} disabled={busy}>
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatement(req.statement);
                setPriority(req.priority);
                setCategory(req.category);
                setEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm">{req.statement}</p>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--color-muted-foreground)]">
            <span>優先度: {req.priority}</span>
            <span>分類: {req.category}</span>
            {req.approved_by && <span>承認: {req.approved_by}</span>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              編集
            </Button>
            <Button
              size="sm"
              onClick={() => void persist({ status: "approved" })}
              disabled={busy || req.status === "approved"}
            >
              承認
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void persist({ status: "rejected" })}
              disabled={busy || req.status === "rejected"}
            >
              却下
            </Button>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-sm text-[var(--color-destructive)]">{error}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: RequirementStatus }) {
  if (status === "approved") return <Badge variant="success">承認済み</Badge>;
  if (status === "rejected") return <Badge variant="destructive">却下</Badge>;
  return <Badge variant="secondary">下書き</Badge>;
}

function formatDate(iso: string): string {
  // SSR/CSR で表記揺れしないよう ISO の日付部分だけを使う。
  return iso.slice(0, 10);
}
