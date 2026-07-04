"use client";

// 深掘りリンクの発行・一覧・失効カード（ADR-0031 決定3 / FR-1.5）。
// owner が期限・回数を決めてリンクを発行し、URL をコピーして利用者/開発者に配る。
// 配布手段（メール等）は SANBA の外。失効の正は API 側の invite 文書（二段検証）。

import { useCallback, useEffect, useState } from "react";

import { Button, Card, CardTitle, Chip, Divider, Field, Input, Select } from "@/components/sanba";
import {
  createProductInvite,
  listProductInvites,
  revokeProductInvite,
  type ProductInvite,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** 期限プリセット（秒）。空文字 = 制限なし（API に ttl_seconds を送らない）。 */
const TTL_CHOICES = [
  { value: "", label: "期限なし" },
  { value: String(24 * 3600), label: "1 日" },
  { value: String(7 * 24 * 3600), label: "7 日" },
  { value: String(30 * 24 * 3600), label: "30 日" },
] as const;

const SCOPE_LABEL: Record<ProductInvite["scope"], string> = {
  developer: "開発者向け",
  end_user: "利用者向け",
};

function formatDate(iso: string | null): string {
  if (!iso) return "なし";
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

/** リンク URL を組む（/join ページは PR5。トークンは URL-safe だが念のためエンコード）。 */
export function inviteUrl(token: string, origin: string): string {
  return `${origin}/join/${encodeURIComponent(token)}`;
}

export function ProductInvitesCard({ productId }: { productId: string }) {
  const auth = useAuth();
  const idToken = auth.credential;

  const [invites, setInvites] = useState<ProductInvite[] | null>(null);
  const [scope, setScope] = useState<ProductInvite["scope"]>("developer");
  const [ttl, setTtl] = useState<string>("");
  const [maxUses, setMaxUses] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    listProductInvites(productId, idToken)
      .then(setInvites)
      .catch(() => setError("深掘りリンクの取得に失敗しました"));
  }, [productId, idToken]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleIssue() {
    // max_uses は 1 以上の整数のみ。空 = 制限なし。
    const uses = maxUses.trim() === "" ? undefined : Number(maxUses);
    if (uses !== undefined && (!Number.isInteger(uses) || uses < 1)) {
      setError("回数上限は 1 以上の整数で入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createProductInvite(
        productId,
        { scope, ttlSeconds: ttl === "" ? undefined : Number(ttl), maxUses: uses },
        idToken,
      );
      reload();
    } catch {
      setError("リンクを発行できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeProductInvite(productId, inviteId, idToken);
      reload();
    } catch {
      setError("失効に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(invite: ProductInvite) {
    const url = inviteUrl(invite.token, window.location.origin);
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
      <CardTitle>深掘りリンク</CardTitle>
      <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
        URL を開くだけでこのアプリの深掘りセッションを始められるリンクです。
        現在はログインした人のみ開けます（利用者向けのゲスト入場は準備中）。
      </p>
      <div className="flex flex-col gap-[10px]">
        <Field label="対象" htmlFor="invite-scope">
          <Select
            id="invite-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as ProductInvite["scope"])}
          >
            <option value="developer">開発者向け（技術の深掘り）</option>
            <option value="end_user">利用者向け（困りごとの聞き取り）</option>
          </Select>
        </Field>
        <div className="flex gap-[10px]">
          <Field label="期限" htmlFor="invite-ttl" className="flex-1">
            <Select id="invite-ttl" value={ttl} onChange={(e) => setTtl(e.target.value)}>
              {TTL_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="回数上限" htmlFor="invite-max-uses" className="flex-1">
            <Input
              id="invite-max-uses"
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="制限なし"
            />
          </Field>
        </div>
        <Button variant="gold" block disabled={busy} onClick={handleIssue}>
          ＋ リンクを発行する
        </Button>
        {error && (
          <p role="alert" className="text-[12px] text-[var(--sanba-rec-text)]">
            {error}
          </p>
        )}
      </div>
      <Divider />
      {invites === null ? (
        <p className="text-[12px] text-[var(--sanba-muted)]">読み込み中…</p>
      ) : invites.length === 0 ? (
        <p className="text-[12px] text-[var(--sanba-muted)]">発行済みのリンクはありません。</p>
      ) : (
        <ul className="flex list-none flex-col gap-[10px] p-0">
          {invites.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-col gap-[8px] rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] p-[12px]"
            >
              <div className="flex items-center gap-[8px]">
                <Chip tone="gold" size="sm">
                  {SCOPE_LABEL[inv.scope]}
                </Chip>
                {inv.revoked && (
                  <Chip tone="danger" size="sm">
                    失効済み
                  </Chip>
                )}
                <span className="ml-auto text-[11px] text-[var(--sanba-muted)]">
                  {formatDate(inv.created_at)} 発行
                </span>
              </div>
              <dl className="flex gap-[16px] text-[12px] text-[var(--sanba-muted)]">
                <div className="flex gap-[4px]">
                  <dt>期限:</dt>
                  <dd>{formatDate(inv.expires_at)}</dd>
                </div>
                <div className="flex gap-[4px]">
                  <dt>使用:</dt>
                  <dd>
                    {inv.use_count} / {inv.max_uses ?? "制限なし"}
                  </dd>
                </div>
              </dl>
              <div className="flex gap-[8px]">
                <Button
                  variant="gold"
                  size="sm"
                  disabled={inv.revoked}
                  onClick={() => handleCopy(inv)}
                  aria-label="リンクをコピー"
                >
                  {copiedId === inv.id ? "コピーしました ✓" : "🔗 リンクをコピー"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || inv.revoked}
                  onClick={() => handleRevoke(inv.id)}
                  aria-label="リンクを失効"
                >
                  失効する
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
