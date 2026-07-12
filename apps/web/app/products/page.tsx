"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { MemberInviteNotices } from "@/components/MemberInviteNotices";
import { authGate } from "@/components/RequireAuth";
import {
  Button,
  Card,
  CardTitle,
  Divider,
  Field,
  HelpIcon,
  Input,
  ListRow,
} from "@/components/sanba";
import { ApiError, createProduct, fetchMyProducts, type Product } from "@/lib/api";
import { cleanSlug } from "@/lib/slug";
import { useAuth } from "@/lib/auth";

export default function ProductsPage() {
  const auth = useAuth();
  const router = useRouter();

  const [products, setProducts] = useState<Product[] | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canFetch = auth.devMode || auth.loggedIn;
  const credential = auth.credential;

  const reload = useCallback(() => {
    fetchMyProducts(credential)
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [credential]);

  useEffect(() => {
    if (!canFetch) return;
    reload();
  }, [canFetch, reload]);

  const gate = authGate(auth, "/products");
  if (gate) return gate;

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("アプリ名を入力してください");
      return;
    }
    const cleanedSlug = cleanSlug(slug);
    if (cleanedSlug === null) {
      setError(
        "URL キーワードは小文字英数とハイフンで 2〜40 文字にしてください（予約された語・先頭末尾のハイフンは不可）",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createProduct(trimmed, cleanedSlug, description.trim(), credential);
      router.push(`/products/${encodeURIComponent(created.id)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("この URL キーワードは既に使われています。別のキーワードにしてください");
      } else if (e instanceof ApiError && e.status === 400) {
        setError("URL キーワードが使えない形式か、予約されたキーワードです");
      } else {
        setError("登録に失敗しました。時間をおいて再度お試しください");
      }
      setBusy(false);
    }
  }

  return (
    <AppShell
      current="products"
      title="アプリ管理"
    >
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-[18px] px-4 py-4 lg:grid lg:max-w-[1040px] lg:grid-cols-2 lg:items-start lg:py-6">
        <div className="empty:hidden lg:col-span-2">
          <MemberInviteNotices onAccepted={reload} />
        </div>
        <Card>
          <CardTitle>アプリを登録</CardTitle>
          <p className="text-[12px] leading-relaxed text-sanba-muted">
            会話の対象になるアプリです。登録すると、前提リポジトリの紐づけと
            会話リンクの発行ができます。
          </p>
          <Field label="アプリ名（必須）" htmlFor="product-name">
            <Input
              id="product-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 経費精算アプリ"
            />
          </Field>
          <Field
            label="URL キーワード（必須）"
            htmlFor="product-slug"
            marker={<HelpIcon term="URL キーワード" className="ml-[4px]" />}
            hint="会話を始める URL（/キーワード/prepare）になります。小文字英数とハイフン・2〜40 文字・全体で重複不可。"
          >
            <Input
              id="product-slug"
              value={slug}
              maxLength={60}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="例: expense-app"
            />
          </Field>
          <Field label="説明（任意）" htmlFor="product-description">
            <Input
              id="product-description"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="どんなアプリか一言で"
            />
          </Field>
          {error && (
            <p role="alert" className="text-[12px] text-sanba-rec-text">
              {error}
            </p>
          )}
          <Button variant="gold" block disabled={busy} onClick={handleCreate}>
            ＋ 登録する
          </Button>
        </Card>

        <Card>
          <CardTitle>登録済みのアプリ</CardTitle>
          <Divider />
          {products === null ? (
            <p className="text-[12px] text-sanba-muted">読み込み中…</p>
          ) : products.length === 0 ? (
            <p className="text-[12px] text-sanba-muted">
              まだアプリがありません。上のフォームから登録してください。
            </p>
          ) : (
            <ul className="flex list-none flex-col gap-[8px] p-0">
              {products.map((p) => (
                <li key={p.id}>
                  <ListRow
                    asChild
                    icon="📦"
                    title={p.role === "member" ? `${p.name}（メンバー）` : p.name}
                    subtitle={
                      (p.description || "説明なし") + (p.github_repo ? ` ・ ${p.github_repo}` : "")
                    }
                  >
                    <button
                      type="button"
                      onClick={() => router.push(`/products/${encodeURIComponent(p.id)}`)}
                      aria-label={`${p.name} の詳細`}
                    />
                  </ListRow>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
