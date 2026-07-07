"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Card, CardTitle } from "@/components/sanba";
import { fetchMyMemberInvites, type MyMemberInvite, respondMemberInvite } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function MemberInviteNotices({
  onAccepted,
}: {
  onAccepted?: (productId: string) => void;
}) {
  const auth = useAuth();
  const idToken = auth.credential;
  const canFetch = auth.devMode || auth.loggedIn;

  const [invites, setInvites] = useState<MyMemberInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchMyMemberInvites(idToken)
      .then(setInvites)
      .catch(() => setInvites([]));
  }, [idToken]);

  useEffect(() => {
    if (!canFetch) return;
    reload();
  }, [canFetch, reload]);

  async function handleRespond(invite: MyMemberInvite, action: "accept" | "decline") {
    setBusyId(invite.id);
    setError(null);
    try {
      await respondMemberInvite(invite.id, action, idToken);
      reload();
      if (action === "accept") onAccepted?.(invite.product_id);
    } catch {
      setError("応答できませんでした。招待が取り消されたか、期限切れの可能性があります");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0) return null;

  return (
    <Card>
      <CardTitle>招待が届いています</CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        承諾すると、そのアプリで要件サンバ（深掘りセッション）ができるようになります。
      </p>
      {error && (
        <p role="alert" className="text-[12px] text-sanba-rec-text">
          {error}
        </p>
      )}
      <ul className="flex list-none flex-col gap-[10px] p-0">
        {invites.map((inv) => (
          <li
            key={inv.id}
            className="flex flex-col gap-[8px] rounded-[12px] border border-sanba-border bg-sanba-surface p-[12px]"
          >
            <p className="text-[13px] text-sanba-cream">
              <span className="font-bold">{inv.product_name}</span> のメンバーに招待されています
            </p>
            <p className="text-[11px] text-sanba-muted">招待した人: {inv.invited_by_email}</p>
            <div className="flex gap-[8px]">
              <Button
                variant="gold"
                size="sm"
                disabled={busyId === inv.id}
                onClick={() => handleRespond(inv, "accept")}
                aria-label={`${inv.product_name} への招待を承諾`}
              >
                承諾する
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === inv.id}
                onClick={() => handleRespond(inv, "decline")}
                aria-label={`${inv.product_name} への招待を辞退`}
              >
                辞退する
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
