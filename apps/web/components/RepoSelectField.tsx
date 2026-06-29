"use client";

// 準備画面のリポジトリ + branch 選択（ADR-0025 / 仕様②③）。連携アカウントが管理する repo を
// 一覧から選び、branch を選ぶ（既定はデフォルトブランチ）。選択は親へ伝え、セッション開始時に
// バインドして非同期索引をキックする。未連携なら設定画面への導線だけを出す。

import { useEffect, useState } from "react";

import {
  getGithubLinkStatus,
  listGithubBranches,
  listGithubRepos,
  type GitHubRepoItem,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface RepoSelection {
  repo: string;
  branch: string;
}

export function RepoSelectField({
  value,
  onChange,
}: {
  value: RepoSelection | null;
  onChange: (sel: RepoSelection | null) => void;
}) {
  const auth = useAuth();
  const idToken = auth.credential;
  const [linked, setLinked] = useState<boolean | null>(null);
  const [repos, setRepos] = useState<GitHubRepoItem[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 連携状態 → repo 一覧を取得する。
  useEffect(() => {
    let alive = true;
    getGithubLinkStatus(idToken)
      .then((s) => {
        if (!alive) return;
        setLinked(s.linked);
        if (s.linked) return listGithubRepos(idToken).then((r) => alive && setRepos(r));
      })
      .catch(() => alive && setError("リポジトリ一覧の取得に失敗しました"));
    return () => {
      alive = false;
    };
  }, [idToken]);

  async function handleRepoChange(fullName: string) {
    if (!fullName) {
      onChange(null);
      setBranches([]);
      return;
    }
    const repo = repos.find((r) => r.full_name === fullName);
    setLoadingBranches(true);
    setError(null);
    try {
      const items = await listGithubBranches(fullName, idToken);
      const names = items.map((b) => b.name);
      setBranches(names);
      // 既定はデフォルトブランチ（ADR-0025）。無ければ先頭。
      const def = repo?.default_branch && names.includes(repo.default_branch)
        ? repo.default_branch
        : (names[0] ?? "");
      onChange(def ? { repo: fullName, branch: def } : null);
    } catch {
      setError("branch 一覧の取得に失敗しました");
    } finally {
      setLoadingBranches(false);
    }
  }

  const selectClass =
    "w-full rounded-[10px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] " +
    "px-3 py-[11px] text-[14px] text-[var(--sanba-cream)]";

  if (linked === false) {
    return (
      <p className="text-[12px] leading-relaxed text-[var(--sanba-muted)]">
        GitHub 未連携です。設定画面で連携すると、リポジトリを前提情報にできます。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[10px]">
      <select
        aria-label="リポジトリ"
        className={selectClass}
        value={value?.repo ?? ""}
        onChange={(e) => handleRepoChange(e.target.value)}
      >
        <option value="">（前提リポジトリを選択）</option>
        {repos.map((r) => (
          <option key={r.full_name} value={r.full_name}>
            {r.full_name}
            {r.private ? "（private）" : ""}
          </option>
        ))}
      </select>
      {value?.repo ? (
        <select
          aria-label="ブランチ"
          className={selectClass}
          disabled={loadingBranches}
          value={value.branch}
          onChange={(e) => onChange({ repo: value.repo, branch: e.target.value })}
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      ) : null}
      {error ? <p className="text-[12px] text-[var(--sanba-danger,#e06)]">{error}</p> : null}
    </div>
  );
}
