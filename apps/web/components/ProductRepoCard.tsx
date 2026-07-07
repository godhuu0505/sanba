"use client";

import { useEffect, useState } from "react";

import { Button, Card, CardTitle, Chip, Divider, Field, Select } from "@/components/sanba";
import {
  fetchGithubRepos,
  listGithubBranches,
  selectProductRepo,
  type GithubRepos,
  type Product,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

const STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "gold" | "success" | "danger" | "info" }> = {
  none: { label: "未紐づけ", tone: "neutral" },
  pending: { label: "索引待ち", tone: "info" },
  indexing: { label: "索引中…", tone: "gold" },
  ready: { label: "索引済み", tone: "success" },
  partial: { label: "一部索引済み", tone: "gold" },
  failed: { label: "索引失敗", tone: "danger" },
};

export function ProductRepoCard({
  product,
  onChanged,
}: {
  product: Product;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const idToken = auth.credential;

  const [choices, setChoices] = useState<GithubRepos | null>(null);
  const [repo, setRepo] = useState(product.github_repo ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState(product.github_branch ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGithubRepos(idToken)
      .then((c) => !cancelled && setChoices(c))
      .catch(() => !cancelled && setChoices({ enabled: false, repos: [], default: null }));
    return () => {
      cancelled = true;
    };
  }, [idToken]);

  const appItem = choices?.linked ? (choices.items ?? []).find((i) => i.full_name === repo) : undefined;
  useEffect(() => {
    if (!appItem) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranch(appItem.default_branch);
    setBranches([appItem.default_branch]);
    listGithubBranches(appItem.full_name, idToken)
      .then((items) => {
        if (cancelled || items.length === 0) return;
        const names = items.map((b) => b.name);
        setBranches(names);
        setBranch((cur) => (names.includes(cur) ? cur : appItem.default_branch));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [appItem, idToken]);

  async function handleBind() {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await selectProductRepo(product.id, repo, branch || null, idToken);
      onChanged();
    } catch {
      setError("紐づけに失敗しました（GitHub 連携・許可リストを確認してください）");
    } finally {
      setBusy(false);
    }
  }

  const status = STATUS_LABEL[product.github_index_status] ?? STATUS_LABEL.none;

  return (
    <Card>
      <CardTitle>前提リポジトリ</CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        紐づけたリポジトリの内容を索引し、このアプリの深掘りセッションの前提として使います。
      </p>
      <div className="flex items-center gap-[8px]">
        <span className="min-w-0 truncate text-[14px] font-bold text-sanba-gold-text">
          {product.github_repo
            ? `${product.github_repo}${product.github_branch ? ` (${product.github_branch})` : ""}`
            : "未紐づけ"}
        </span>
        <Chip tone={status.tone} size="sm">
          {status.label}
        </Chip>
      </div>
      <Divider />
      {choices === null ? (
        <p className="text-[12px] text-sanba-muted">候補を取得しています…</p>
      ) : !choices.linked ? (
        <p className="text-[12px] leading-relaxed text-sanba-muted">
          リポジトリの紐づけには GitHub 連携が必要です。アカウント設定の「GitHub 連携」から
          連携してください。
        </p>
      ) : (
        <div className="flex flex-col gap-[10px]">
          <Field label="リポジトリ" htmlFor="product-repo">
            <Select id="product-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">選択してください</option>
              {choices.repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          {appItem && (
            <Field label="ブランチ" htmlFor="product-branch" hint="既定はデフォルトブランチ">
              <Select
                id="product-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-sanba-rec-text">
              {error}
            </p>
          )}
          <Button variant="outline" block disabled={busy || !repo} onClick={handleBind}>
            {product.github_repo ? "紐づけを更新する" : "紐づけて索引する"}
          </Button>
        </div>
      )}
    </Card>
  );
}
