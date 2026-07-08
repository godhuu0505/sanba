"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Card, CardTitle, Chip, Divider, Field, Input } from "@/components/sanba";
import {
  createMemberInvite,
  fetchProductMembers,
  listMemberInvites,
  type ProductMember,
  type ProductMemberInvite,
  removeProductMember,
  revokeMemberInvite,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

const STATUS_LABEL: Record<string, string> = {
  pending: "応答待ち",
  accepted: "承諾済み",
  declined: "辞退",
  revoked: "取り消し済み",
  expired: "期限切れ",
};

function formatDate(iso: string | null): string {
  if (!iso) return "なし";
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

export function memberInviteUrl(token: string, origin: string): string {
  return `${origin}/member-invites/${encodeURIComponent(token)}`;
}

export function ProductMembersCard({
  productId,
  canManage,
}: {
  productId: string;
  canManage: boolean;
}) {
  const auth = useAuth();
  const idToken = auth.credential;

  const [members, setMembers] = useState<ProductMember[] | null>(null);
  const [invites, setInvites] = useState<ProductMemberInvite[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchProductMembers(productId, idToken)
      .then(setMembers)
      .catch(() => setError("メンバーの取得に失敗しました"));
    if (canManage) {
      listMemberInvites(productId, idToken)
        .then(setInvites)
        .catch(() => setError("招待の取得に失敗しました"));
    }
  }, [productId, idToken, canManage]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleInvite() {
    const target = email.trim();
    if (!target) {
      setError("招待するメールアドレスを入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createMemberInvite(productId, target, idToken);
      setEmail("");
      reload();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) setError("そのアドレスは既にメンバーか、招待済みです");
      else if (status === 400) setError("メールアドレスの形式を確認してください");
      else setError("招待できませんでした。時間をおいて再度お試しください");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(sub: string) {
    setBusy(true);
    setError(null);
    try {
      await removeProductMember(productId, sub, idToken);
      reload();
    } catch {
      setError("メンバーを外せませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeMemberInvite(productId, inviteId, idToken);
      reload();
    } catch {
      setError("招待を取り消せませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(invite: ProductMemberInvite) {
    const url = memberInviteUrl(invite.token, window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(invite.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === invite.id ? null : cur)), 2000);
    } catch {
      setError("コピーできませんでした。リンクを手動で選択してください");
    }
  }

  return (
    <Card>
      <CardTitle>メンバー</CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        このアプリで会話ができる人です。
        {canManage &&
          "メールアドレスで招待すると、招待メールと SANBA 内の通知が届き、承諾するとメンバーになります。"}
      </p>
      {canManage && (
        <div className="flex flex-col gap-[10px]">
          <Field label="招待するメールアドレス" htmlFor="member-invite-email">
            <Input
              id="member-invite-email"
              type="email"
              value={email}
              maxLength={320}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleInvite();
                }
              }}
              placeholder="例: taro@example.com"
            />
          </Field>
          <Button variant="gold" block disabled={busy} onClick={handleInvite}>
            ＋ 招待する
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-sanba-rec-text">
          {error}
        </p>
      )}
      <Divider />
      {members === null ? (
        <p className="text-[12px] text-sanba-muted">読み込み中…</p>
      ) : members.length === 0 ? (
        <p className="text-[12px] text-sanba-muted">まだメンバーはいません。</p>
      ) : (
        <ul className="flex list-none flex-col gap-[10px] p-0">
          {members.map((m) => (
            <li
              key={m.sub}
              className="flex items-center gap-[8px] rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px]"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] text-sanba-cream">
                  {m.display_name || m.email}
                </span>
                <span className="truncate text-[11px] text-sanba-muted">
                  {m.email} ・ {formatDate(m.created_at)} 参加
                </span>
              </div>
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto shrink-0"
                  disabled={busy}
                  onClick={() => handleRemove(m.sub)}
                  aria-label={`${m.email} を外す`}
                >
                  外す
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && invites !== null && invites.length > 0 && (
        <>
          <Divider />
          <p className="text-[12px] font-bold text-sanba-muted">招待の状況</p>
          <ul className="flex list-none flex-col gap-[10px] p-0">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-[8px] rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px]"
              >
                <div className="flex items-center gap-[8px]">
                  <Chip tone={inv.status === "pending" ? "gold" : "neutral"} size="sm">
                    {STATUS_LABEL[inv.status] ?? inv.status}
                  </Chip>
                  <span className="ml-auto text-[11px] text-sanba-muted">
                    {formatDate(inv.created_at)} 招待
                  </span>
                </div>
                <p className="truncate text-[13px] text-sanba-cream">{inv.email}</p>
                <p className="text-[11px] text-sanba-muted">期限: {formatDate(inv.expires_at)}</p>
                {inv.status === "pending" && (
                  <div className="flex gap-[8px]">
                    <Button
                      variant="gold"
                      size="sm"
                      onClick={() => handleCopy(inv)}
                      aria-label="招待リンクをコピー"
                    >
                      {copiedId === inv.id ? "コピーしました ✓" : "🔗 招待リンクをコピー"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleRevoke(inv.id)}
                      aria-label="招待を取り消す"
                    >
                      取り消す
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
