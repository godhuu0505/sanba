"use client";

// アプリの前提リポジトリ紐づけカード（ADR-0031 / FR-1.3）。
// 02 準備の repo+branch 選択（app/page.tsx / ADR-0027・0028）と同じ API を使い、
// POST /api/products/{id}/github で product 単位に紐づけ・索引する。
// 紐づけは GitHub App 連携済み（repos.linked）が前提（API が 409 を返す）。

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

/** 索引状態 → 表示ラベルとトーン（ubiquitous-language: GitHubIndexStatus）。 */
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
  /** 紐づけ完了（indexing 開始）後に親が product を再取得するためのフック。 */
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

  // 候補一覧はこのカードのマウント時に取得する。管理画面は明示的に「紐づけに来た」
  // 文脈なので、02 準備の「入るまで叩かない」原則（ADR-0027）と整合する。
  useEffect(() => {
    let cancelled = false;
    fetchGithubRepos(idToken)
      .then((c) => !cancelled && setChoices(c))
      .catch(() => !cancelled && setChoices({ enabled: false, repos: [], default: null }));
    return () => {
      cancelled = true;
    };
  }, [idToken]);

  // repo を選んだら branch 一覧を取得（既定はデフォルトブランチ / ADR-0028）。
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
      .catch(() => {
        // branch 一覧の不調はデフォルトブランチのまま進める（本流を止めない）。
      });
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
