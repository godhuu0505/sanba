"use client";

// アプリ管理（一覧・登録）画面（ADR-0031 / FR-1.1）。
// 開発者 / PdM が深掘り対象の「アプリ」を登録し、詳細（/products/[id]）で
// repo 紐づけ・利用者向け語彙・深掘りリンクの発行を行う入口。
// 設定画面（app/settings）と同じ認証ゲート + SANBA デザインシステムの流儀で作る。

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AccountMenu } from "@/components/AccountMenu";
import { MemberInviteNotices } from "@/components/MemberInviteNotices";
import { authGate } from "@/components/RequireAuth";
import {
  AppHeader,
  Button,
  Card,
  CardTitle,
  Divider,
  Field,
  Input,
  ListRow,
  Screen,
} from "@/components/sanba";
import { ApiError, createProduct, fetchMyProducts, type Product } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function ProductsPage() {
  const auth = useAuth();
  const router = useRouter();

  const [products, setProducts] = useState<Product[] | null>(null);
  const [name, setName] = useState("");
  // URL キーワード（必須・グローバル一意 / ADR-0040）。/{slug}/prepare 等の URL になる。
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // dev モード（authGate 素通し）は credential=null のまま API の AUTH_DEV_BYPASS に委ねる。
  // 実モードでは gate がリダイレクトするまで fetch を抑止する（401 ノイズを出さない）。
  const canFetch = auth.devMode || auth.loggedIn;
  const credential = auth.credential;

  // 一覧の取得（新しい順は API 側が保証 / FR-1.1）。取得失敗は空状態のまま UX を止めない。
  // 招待の承諾（MemberInviteNotices）後にも呼び直し、増えた分を即反映する（ADR-0036）。
  const reload = useCallback(() => {
    fetchMyProducts(credential)
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [credential]);

  useEffect(() => {
    if (!canFetch) return;
    reload();
  }, [canFetch, reload]);

  // 厳密な認証ゲート（設定画面と同じ）。未ログインは /login?next=/products へ。
  const gate = authGate(auth, "/products");
  if (gate) return gate;

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("アプリ名を入力してください");
      return;
    }
    // slug は API と同じ規則へ正規化してから送る（小文字英数とハイフン・2〜40 文字 /
    // ADR-0040）。形式違反はサーバへ投げる前にその場で指摘する。
    const cleanedSlug = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(cleanedSlug)) {
      setError(
        "URL キーワードは小文字英数とハイフンで 2〜40 文字にしてください（先頭・末尾のハイフン不可）",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createProduct(trimmed, cleanedSlug, description.trim(), credential);
      // 登録後は詳細へ。repo 紐づけ・深掘りリンク発行は詳細画面で続ける。
      router.push(`/products/${encodeURIComponent(created.id)}`);
    } catch (e) {
      // 409 = slug 使用済み（グローバル一意）、400 = 形式・予約語（サーバ側の最終判定）。
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
    <Screen className="px-4 py-3 sanba-scroll">
      <AppHeader
        title="アプリ管理"
        onBack={() => router.push("/")}
        right={<AccountMenu profile={auth.profile} />}
      />
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-[18px] pt-2">
        {/* 自分宛のメンバー招待（ADR-0036）。承諾すると一覧を再取得して即反映する。 */}
        <MemberInviteNotices onAccepted={reload} />
        <Card>
          <CardTitle>アプリを登録</CardTitle>
          <p className="text-[12px] leading-relaxed text-sanba-muted">
            深掘りの対象になるアプリです。登録すると、リポジトリの紐づけと
            深掘りリンクの発行ができます。
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
            hint="壁打ちの URL（/キーワード/prepare）になります。小文字英数とハイフン・2〜40 文字・全体で重複不可。"
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
      </main>
    </Screen>
  );
}
