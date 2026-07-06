"use client";

// アプリ詳細画面（ADR-0031 / FR-1.2, FR-1.3, FR-1.5）。
// 基本情報（name/description）と利用者向け語彙の編集、前提リポジトリの紐づけ、
// 深掘りリンクの発行・失効、アプリの削除を行う。
// 認可の源泉は API（_require_product_access）: 非所有・不存在はどちらも 404 が返るので、
// web は「見つからない」表示に平すだけで owner 判定を複製しない。

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AccountMenu } from "@/components/AccountMenu";
import { ProductInvitesCard } from "@/components/ProductInvitesCard";
import { ProductMembersCard } from "@/components/ProductMembersCard";
import { ProductRepoCard } from "@/components/ProductRepoCard";
import { authGate } from "@/components/RequireAuth";
import {
  AppHeader,
  Button,
  Card,
  CardTitle,
  Chip,
  Divider,
  Field,
  Input,
  Screen,
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
  // URL キーワード（必須・グローバル一意 / ADR-0040）。既存アプリ（slug 未設定）は
  // ここで設定するまで壁打ちを開始できないため、空のまま促す。
  const [slugInput, setSlugInput] = useState("");
  const [description, setDescription] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // dev モード（authGate 素通し）は credential=null のまま API の AUTH_DEV_BYPASS に委ねる。
  // 実モードでは gate がリダイレクトするまで fetch を抑止する（401 ノイズを出さない）。
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
        // 404 = 不存在または非所有（存在秘匿）。どちらも「見つからない」に平す。
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError("読み込みに失敗しました");
      });
  }, [productId, credential]);

  useEffect(() => {
    if (!canFetch) return;
    load();
  }, [canFetch, load]);

  // 索引中はポーリングして状態（indexing → ready/partial/failed）を追う。
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
    // slug は必須（ADR-0040）。API と同じ規則へ正規化し、形式違反・予約語は送信前に
    // 指摘する。既存アプリ（未設定）もこの保存で設定してもらう（設定するまで壁打ち開始不可）。
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

  // 語彙は操作ごとに即保存する（追加/削除のたびに PATCH。失敗時は表示を巻き戻す）。
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
      <Screen className="px-4 py-3 sanba-scroll">
        <AppHeader title="アプリ詳細" onBack={() => router.push("/products")} />
        <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
          <Card>
            <CardTitle>見つかりません</CardTitle>
            <p className="text-[12px] leading-relaxed text-sanba-muted">
              このアプリは存在しないか、閲覧できません。
            </p>
            <Button variant="outline" block onClick={() => router.push("/products")}>
              アプリ管理へ戻る
            </Button>
          </Card>
        </main>
      </Screen>
    );
  }

  return (
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader
        title="アプリ詳細"
        onBack={() => router.push("/products")}
        right={<AccountMenu profile={auth.profile} />}
      />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {product === null ? (
          <Card>
            <p className="text-[12px] text-sanba-muted">読み込み中…</p>
          </Card>
        ) : product.role === "member" ? (
          // メンバー閲覧（ADR-0036）: 管理操作（編集・repo・リンク・削除）は出さず、
          // 概要とメンバー一覧のみ。要件サンバの開始はホームの準備画面から行う。
          <>
            <Card>
              <CardTitle>{product.name}</CardTitle>
              {product.description && (
                <p className="text-[13px] leading-relaxed text-sanba-cream">
                  {product.description}
                </p>
              )}
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                あなたはこのアプリのメンバーです。ホームの「壁打ちを始める」から
                対象にこのアプリを選ぶと、要件サンバを始められます。
              </p>
              {/* slug 設定済みならこのアプリの準備 URL へ直行。未設定（既存アプリ）は
                  ホームへ送り、オーナーによる設定を待つ（ADR-0040）。 */}
              <Button
                variant="gold"
                block
                onClick={() => router.push(product.slug ? `/${product.slug}/prepare` : "/")}
              >
                要件サンバを始める
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
                hint={
                  product.slug
                    ? `壁打ちの URL は /${product.slug}/prepare です。変更すると URL も変わります。`
                    : "未設定です。設定するまでこのアプリでは壁打ちを始められません（/キーワード/prepare が壁打ちの URL になります）。"
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
              <CardTitle>利用者向け語彙</CardTitle>
              <p className="text-[12px] leading-relaxed text-sanba-muted">
                利用者に見えている言葉（画面名・機能の呼び名）です。利用者向けの深掘りでは
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
                削除すると発行済みの深掘りリンクもすべて使えなくなります。
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
      </main>
    </Screen>
  );
}
