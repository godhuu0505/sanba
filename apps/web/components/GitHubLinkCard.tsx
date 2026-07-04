"use client";

// 設定画面の GitHub 連携カード（ADR-0028 / 仕様①）。連携アカウントの表示・連携開始・解除を行う。
// 連携状態は Google idToken（require_user）で取得する。連携開始は GitHub App のインストール
// URL へ遷移し、完了後 ?linked=1 で戻る。解除は users/{sub} の installation 記録のみ消す
// （共有索引は残す / ADR-0028）。

import { useEffect, useState } from "react";

import { Button, Card, CardTitle, Divider } from "@/components/sanba";
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
      // GitHub App のインストール/repo 選択画面へ遷移する（完了後 ?linked=1 で戻る）。
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
      <CardTitle>GitHub 連携</CardTitle>
      <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
        リポジトリを 1 つ紐づけると、要件サンバの深掘り時に前提情報として扱えます。
      </p>
      <Divider />
      {status?.linked ? (
        <div className="flex flex-col gap-[10px]">
          <div className="flex items-baseline justify-between gap-[12px]">
            <span className="text-[13px] text-[var(--sanba-muted)]">連携中</span>
            <span className="truncate text-[14px] font-bold text-[var(--sanba-gold-text)]">
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
      {error ? <p className="text-[12px] text-[var(--sanba-danger,#e06)]">{error}</p> : null}
    </Card>
  );
}
