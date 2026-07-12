"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { ProductCheckItemsCard } from "@/components/ProductCheckItemsCard";
import { ProductInvitesCard } from "@/components/ProductInvitesCard";
import { ProductOutputFormatsCard } from "@/components/ProductOutputFormatsCard";
import { ProductMembersCard } from "@/components/ProductMembersCard";
import { ProductRepoCard } from "@/components/ProductRepoCard";
import { authGate } from "@/components/RequireAuth";
import {
  Button,
  Card,
  CardTitle,
  Chip,
  Divider,
  Field,
  HelpIcon,
  Input,
} from "@/components/sanba";
import {
  ApiError,
  deleteProduct,
  fetchProduct,
  updateProduct,
  type Product,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cleanSlug } from "@/lib/slug";

export default function ProductDetailPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const productId = params.id;

  const [product, setProduct] = useState<Product | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const [description, setDescription] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canFetch = auth.devMode || auth.loggedIn;
  const credential = auth.credential;

  const load = useCallback(() => {
    fetchProduct(productId, credential)
      .then((p) => {
        setProduct(p);
        setName(p.name);
        setSlugInput(p.slug ?? "");
        setDescription(p.description);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError("読み込みに失敗しました");
      });
  }, [productId, credential]);

  useEffect(() => {
    if (!canFetch) return;
    load();
  }, [canFetch, load]);

  useEffect(() => {
    if (product?.github_index_status !== "indexing") return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [product?.github_index_status, load]);

  const gate = authGate(auth, `/products/${productId}`);
  if (gate) return gate;

  async function handleSaveBasics() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("アプリ名を入力してください");
      return;
    }
    const cleanedSlug = cleanSlug(slugInput);
    if (cleanedSlug === null) {
      setError(
        "URL キーワードは小文字英数とハイフンで 2〜40 文字にしてください（予約された語・先頭末尾のハイフンは不可）",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProduct(
        productId,
        { name: trimmed, slug: cleanedSlug, description },
        credential,
      );
      setProduct(updated);
      setSlugInput(updated.slug ?? "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("この URL キーワードは既に使われています。別のキーワードにしてください");
      } else if (e instanceof ApiError && e.status === 400) {
        setError("URL キーワードが使えない形式か、予約されたキーワードです");
      } else {
        setError("保存に失敗しました");
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveGlossary(next: string[]) {
    if (!product) return;
    const prev = product;
    setProduct({ ...product, glossary: next });
    try {
      setProduct(await updateProduct(productId, { glossary: next }, credential));
    } catch {
      setProduct(prev);
      setError("語彙の保存に失敗しました");
    }
  }

  function handleAddTerm() {
    const term = newTerm.trim();
    if (!term || !product) return;
    if (term.length > 100) {
      setError("語彙は 100 文字以内で入力してください");
      return;
    }
    if (product.glossary.includes(term)) {
      setNewTerm("");
      return;
    }
    setNewTerm("");
    void saveGlossary([...product.glossary, term]);
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteProduct(productId, credential);
      router.push("/products");
    } catch {
      setError("削除に失敗しました");
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <AppShell current="products" title="アプリ詳細" onBack={() => router.push("/products")}>
        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] px-4 py-4">
          <Card>
            <CardTitle>見つかりません</CardTitle>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              このアプリは存在しないか、閲覧できません。
            </p>
            <Button variant="outline" block onClick={() => router.push("/products")}>
              アプリ管理へ戻る
            </Button>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell current="products" title="アプリ詳細" onBack={() => router.push("/products")}>
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] px-4 py-4 lg:grid lg:max-w-[1040px] lg:grid-cols-2 lg:items-start lg:py-6">
        {product === null ? (
          <Card>
            <p className="text-[12px] text-sanba-muted">読み込み中…</p>
          </Card>
        ) : product.role === "member" ? (
          <>
            <Card>
              <CardTitle>{product.name}</CardTitle>
              {product.description && (
                <p className="text-[13px] leading-relaxed text-sanba-cream">
                  {product.description}
                </p>
              )}
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                あなたはこのアプリのメンバーです。ホームの「会話を始める」から
                対象にこのアプリを選ぶと、会話を始められます。
              </p>
              <Button
                variant="gold"
                block
                onClick={() => router.push(product.slug ? `/${product.slug}/prepare` : "/")}
              >
                会話を始める
              </Button>
            </Card>
            <ProductMembersCard productId={productId} canManage={false} />
          </>
        ) : (
          <>
            <Card>
              <CardTitle>基本情報</CardTitle>
              <Field label="アプリ名（必須）" htmlFor="product-name">
                <Input
                  id="product-name"
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="URL キーワード（必須）"
                htmlFor="product-slug"
                marker={<HelpIcon term="URL キーワード" className="ml-[4px]" />}
                hint={
                  product.slug
                    ? `会話を始める URL は /${product.slug}/prepare です。変更すると URL も変わります。`
                    : "未設定です。設定するまでこのアプリでは会話を始められません（/キーワード/prepare が会話を始める URL になります）。"
                }
              >
                <Input
                  id="product-slug"
                  value={slugInput}
                  maxLength={60}
                  onChange={(e) => setSlugInput(e.target.value)}
                  placeholder="例: expense-app"
                />
              </Field>
              <Field label="説明（任意）" htmlFor="product-description">
                <Input
                  id="product-description"
                  value={description}
                  maxLength={2000}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Button variant="outline" block disabled={busy} onClick={handleSaveBasics}>
                保存する
              </Button>
            </Card>

            <Card>
              <CardTitle className="inline-flex items-center gap-[6px]">
                利用者向け語彙
                <HelpIcon term="利用者向け語彙" />
              </CardTitle>
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                利用者に見えている言葉（画面名・機能の呼び名）です。利用者向けの会話では
                この語彙で質問し、技術用語を使いません。
              </p>
              {product.glossary.length > 0 && (
                <div className="flex flex-wrap gap-[8px]">
                  {product.glossary.map((term) => (
                    <Chip key={term} tone="neutral" size="md">
                      {term}
                      <button
                        type="button"
                        aria-label={`${term} を削除`}
                        className="ml-[4px] text-sanba-muted hover:text-sanba-cream"
                        onClick={() =>
                          void saveGlossary(product.glossary.filter((t) => t !== term))
                        }
                      >
                        ✕
                      </button>
                    </Chip>
                  ))}
                </div>
              )}
              <div className="flex gap-[8px]">
                <Input
                  aria-label="語彙を追加"
                  value={newTerm}
                  maxLength={100}
                  onChange={(e) => setNewTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTerm();
                    }
                  }}
                  placeholder="例: 請求書一覧"
                />
                <Button variant="outline" size="md" onClick={handleAddTerm}>
                  追加
                </Button>
              </div>
            </Card>

            <ProductOutputFormatsCard product={product} onSaved={setProduct} />
            <ProductCheckItemsCard product={product} onSaved={setProduct} />

            <ProductRepoCard product={product} onChanged={load} />
            <ProductMembersCard productId={productId} canManage />
            <ProductInvitesCard productId={productId} />

            {error && (
              <p role="alert" className="text-[12px] text-sanba-rec-text">
                {error}
              </p>
            )}

            <Card>
              <CardTitle>アプリの削除</CardTitle>
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                削除すると発行済みの会話リンクもすべて使えなくなります。
              </p>
              <Divider />
              {confirmDelete ? (
                <div className="flex flex-col gap-[8px]">
                  <p className="text-[13px] font-bold text-sanba-rec-text">
                    本当に「{product.name}」を削除しますか？この操作は取り消せません。
                  </p>
                  <div className="flex gap-[8px]">
                    <Button variant="gold" size="sm" disabled={busy} onClick={handleDelete}>
                      削除する
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                      やめる
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" block onClick={() => setConfirmDelete(true)}>
                  削除する…
                </Button>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
