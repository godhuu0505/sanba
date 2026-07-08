"use client";

import { useEffect, useState } from "react";

import { Button, Card, CardTitle, Divider, HelpIcon } from "@/components/sanba";
import {
  getGithubLinkStatus,
  startGithubLink,
  unlinkGithub,
  type GitHubLinkStatus,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function GitHubLinkCard() {
  const auth = useAuth();
  const idToken = auth.credential;
  const [status, setStatus] = useState<GitHubLinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getGithubLinkStatus(idToken)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setError("連携状態の取得に失敗しました"));
    return () => {
      alive = false;
    };
  }, [idToken]);

  async function handleLink() {
    setBusy(true);
    setError(null);
    try {
      const { install_url } = await startGithubLink(idToken);
      window.location.href = install_url;
    } catch {
      setError("連携を開始できませんでした（GitHub App 未設定の可能性）");
      setBusy(false);
    }
  }

  async function handleUnlink() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await unlinkGithub(idToken));
    } catch {
      setError("連携解除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-[6px]">
        <CardTitle>GitHub 連携</CardTitle>
        <HelpIcon term="前提リポジトリ" />
      </div>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        リポジトリを 1 つ紐づけると、会話の前提として使えます。
      </p>
      <Divider />
      {status?.linked ? (
        <div className="flex flex-col gap-[10px]">
          <div className="flex items-baseline justify-between gap-[12px]">
            <span className="text-[13px] text-sanba-muted">連携中</span>
            <span className="truncate text-[14px] font-bold text-sanba-gold-text">
              {status.github_login ?? "（不明）"}
            </span>
          </div>
          <Button
            variant="outline"
            block
            disabled={busy}
            onClick={handleUnlink}
            aria-label="GitHub 連携を解除"
          >
            連携を解除
          </Button>
        </div>
      ) : (
        <Button
          variant="gold"
          block
          disabled={busy}
          onClick={handleLink}
          aria-label="GitHub と連携"
        >
          GitHub と連携する
        </Button>
      )}
      {error ? <p className="text-[12px] text-sanba-rec-text">{error}</p> : null}
    </Card>
  );
}
